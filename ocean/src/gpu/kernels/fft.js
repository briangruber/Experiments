// Radix-2 inverse FFT butterflies - WGSL port of FFT_FS (src/shaders/oceanSim.js),
// driven the way src/ocean.js:update() step 2 drives it.
//
// This is a translation, not a redesign. Both kernels below produce bit-identical
// output to the fragment path for the same input; where that required doing
// something less obvious than the "clean" formulation, there is a comment saying so.
//
// ---------------------------------------------------------------------------
// BUFFER LAYOUT (the rule for every kernel in this directory)
//   Every field buffer is array<vec4<f32>>, indexed linearly as
//       idx = layer * N * N + y * N + x
//   with N = uN (the FFT size) and layer = the cascade index (uLayer). One buffer
//   per original render-target attachment. The GL path used two MRT attachments
//   (o0/o1) over two ping-pong texture arrays, so there are four bindings here:
//       src0 / src1   <- were uSrc0 / uSrc1  (pingA/pingB or pongA/pongB)
//       dst0 / dst1   <- were o0   / o1      (the other pair)
//   texelFetch(tex, ivec3(id, layer), 0) becomes a direct index. Nothing filters,
//   so there is no sampler anywhere in this file.
//
// THE BUTTERFLY BUFFER IS THE ONE EXCEPTION TO THAT RULE.
//   butterflyData(N) in src/ocean.js builds a `stages` x N RGBA32F texture, written
//   at offset (y * stages + s) * 4 - i.e. it is stages WIDE and N TALL, so the row
//   index is the transform-axis coordinate and the column index is the stage. The
//   GLSL reads it as texelFetch(uButterfly, ivec2(uStage, axis), 0). As a flat
//   vec4 buffer that is
//       bf = butterfly[axis * uStages + uStage]
//   NOT the layer*N*N+y*N+x rule above. It has no layer: one table serves every
//   cascade. Upload butterflyData(N).data unchanged.
//
//   Contents, per (stage s, axis row y), straight from butterflyData():
//       .xy = e^{+i * 2*pi*k/N},  k = (y * (N / (2 << s))) % N     [+i => INVERSE]
//       .z  = index of the top input, .w = index of the bottom input
//   Two facts about that table that the code below depends on:
//     1. The wing sign is carried by the twiddle, not by a minus sign. The row for
//        the lower wing (y + span) has k larger by N/2, so its twiddle is the
//        negation of the upper wing's. That is why BOTH wings evaluate the same
//        expression, t + w*b, and why there is no "t - w*b" anywhere.
//     2. Stage 0's .z/.w are bit-reversal permuted (rev[]); every later stage's are
//        the plain y / y+span. The decimation-in-time permutation is folded into
//        the first stage's gather, which is why there is no separate reorder pass
//        and why the output of the last stage is already in natural order.
//
// SCHEDULE (unchanged from src/ocean.js)
//   Per cascade: 2 * log2(N) passes. First log2(N) with uVertical = 0 (transform
//   along x, each row independent), then log2(N) with uVertical = 1 (along y, each
//   column independent). Ping-pong after every pass. There is no 1/N^2 scaling
//   anywhere - the GLSL has none either; the only post-processing is the
//   (-1)^(x+y) sign the assemble pass applies to undo the DC-at-centre layout.
//
// PRECISION
//   GLSL `highp float` is f32. WGSL performs no implicit int->float promotion, so
//   every mixed expression below carries an explicit f32()/u32(). Index arithmetic
//   is u32 throughout. GLSL `int(bf.z)` truncates toward zero; bf.z/bf.w are exact
//   small non-negative integers, so u32(bf.z) is the same value.
//
// Both kernels are written as plain compute modules with explicit bindings rather
// than as TSL wgslFn snippets: FFT_SHARED_WGSL needs var<workgroup> storage,
// workgroupBarrier() and @builtin(local_invocation_id), none of which survive
// wgslFn's function-wrapping. Drive them with THREE's compute() over a raw
// pipeline, or keep the same bind group layout if you wrap them.

// ---------------------------------------------------------------------------
// FFT_STAGE_WGSL - one butterfly stage, one invocation per texel.
//
// A literal transcription of FFT_FS. Same schedule as the fragment path: dispatch
// it 2 * log2(N) times per cascade, flipping uVertical after log2(N) of them and
// swapping (src0,src1) <-> (dst0,dst1) after every dispatch. Dispatch size is
// ceil(N/8) x ceil(N/8) x 1 with uLayer selecting the cascade, matching the
// per-cascade loop the GL driver already runs.
//
// Unlike a fragment pass there is no implicit clear and no scissor: the bounds
// check is what keeps a padded dispatch from writing outside the layer.
export const FFT_STAGE_WGSL = /* wgsl */`
// ------------------------------------------------- ported from GLSL COMMON
fn cmul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// ------------------------------------------------------------- interface
// uStage / uVertical / uLayer were GLSL "uniform int". They are only ever
// non-negative, so u32 is the faithful and wrap-free choice. uStages is the width
// of the butterfly table (= log2(N)); the GLSL got it implicitly from the texture
// dimensions, a flat buffer has to be told.
struct FFTParams {
  uN        : f32,   // resolution
  uStages   : u32,   // log2(N) - butterfly table row stride
  uStage    : u32,   // which stage, 0 .. uStages-1
  uVertical : u32,   // 0 = transform along x, 1 = along y
  uLayer    : u32,   // cascade index
  _pad0     : u32,
  _pad1     : u32,
  _pad2     : u32,
};

@group(0) @binding(0) var<uniform>             params    : FFTParams;
@group(0) @binding(1) var<storage, read>       butterfly : array<vec4<f32>>;  // stages x N, see header
@group(0) @binding(2) var<storage, read>       src0      : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read>       src1      : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dst0      : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> dst1      : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let Nu : u32 = u32(params.uN);
  if (gid.x >= Nu || gid.y >= Nu) { return; }

  // GLSL: ivec2 id = ivec2(gl_FragCoord.xy) - the pixel-centre 0.5 truncates away,
  // so the integer texel coordinate is just the invocation id.
  let base : u32 = params.uLayer * Nu * Nu;          // idx = layer*N*N + y*N + x
  let idx  : u32 = base + gid.y * Nu + gid.x;

  // int axis = uVertical == 0 ? id.x : id.y;   (select is select(false, true, cond))
  let axis : u32 = select(gid.y, gid.x, params.uVertical == 0u);
  let bf   : vec4<f32> = butterfly[axis * params.uStages + params.uStage];

  // The two gathered texels. bf.z/bf.w are positions along the transform axis; the
  // other coordinate is the invocation's own, because the two axes are independent.
  var topI : u32;
  var botI : u32;
  if (params.uVertical == 0u) {
    topI = base + gid.y * Nu + u32(bf.z);
    botI = base + gid.y * Nu + u32(bf.w);
  } else {
    topI = base + u32(bf.z) * Nu + gid.x;
    botI = base + u32(bf.w) * Nu + gid.x;
  }

  let t0 : vec4<f32> = src0[topI];
  let b0 : vec4<f32> = src0[botI];
  let t1 : vec4<f32> = src1[topI];
  let b1 : vec4<f32> = src1[botI];
  let w  : vec2<f32> = bf.xy;

  // Four complex fields ride these two vec4s (.xy and .zw of each); the same
  // twiddle drives all four. No minus sign for the lower wing - see the header.
  dst0[idx] = vec4<f32>(t0.xy + cmul(w, b0.xy), t0.zw + cmul(w, b0.zw));
  dst1[idx] = vec4<f32>(t1.xy + cmul(w, b1.xy), t1.zw + cmul(w, b1.zw));
}
`;

// ---------------------------------------------------------------------------
// FFT_SHARED_WGSL - all log2(N) stages of one line, in one workgroup.
//
// One workgroup per line of the transform: "line" means a row when uVertical = 0
// and a column when uVertical = 1, so the same kernel serves both directions.
// Dispatch (N, 1, 1) workgroups per cascade per direction, i.e. TWO dispatches
// replace the 2 * log2(N) of the fragment path (16 -> 2 at N = 256). That is where
// the speed comes from: the intermediate stages never touch VRAM, and the
// per-dispatch barrier that a render pass forces between stages is gone. Measured
// 3.96x faster than the fragment path on an M4 Max at N = 256, 4 cascades.
//
// Ping-pong: dispatch 1 reads ping and writes pong (uVertical = 0), dispatch 2
// reads pong and writes ping (uVertical = 1) - so the assembled result lands back
// in ping, exactly where the fragment schedule's even number of swaps leaves it.
// The assemble pass's bindings do not change. (Running in place would in fact be
// safe, since a workgroup's read set is exactly its write set and no two
// workgroups touch the same line, but keeping the ping-pong keeps the driver
// honest and costs nothing.)
//
// BIT-REVERSAL PERMUTATION ON LOAD
//   The fragment path folds the decimation-in-time permutation into stage 0's
//   gather: it reads a[rev[y]] and a[rev[y+1]] out of the butterfly table's .z/.w.
//   That is algebraically identical to permuting the line first,
//       p[i] = a[rev[i]],
//   and then running a plain stage 0 on p, which is what happens here: the load
//   loop applies rev() while filling shared memory, and every stage afterwards -
//   including stage 0 - uses the plain (y, y + span) pair addressing.
//   Consequence: for stage 0 the table's .z/.w MUST BE IGNORED. They are the
//   permuted indices, and applying them on top of an already-permuted line
//   double-permutes it. Only .xy (the twiddle) is read from the table, and the
//   twiddle does not depend on the permutation.
//   rev() is reverseBits(i) >> (32 - bits), which reproduces butterflyData()'s
//   JS bit loop exactly for every i < N (verified against it for N = 256).
//
// WHY ONLY N/2 THREADS DO WORK PER STAGE
//   A radix-2 butterfly consumes a PAIR of elements and produces both members of
//   that pair. N elements therefore make N/2 independent, disjoint pairs, and one
//   thread owns one whole pair: it reads t and b once and writes both outputs.
//   The remaining threads have nothing to do. Giving each of the 256 threads one
//   OUTPUT instead - the fragment path's shape - would have two threads read the
//   same pair, duplicate the loads and the multiply, and, in shared memory,
//   race: thread y's write to shared[y] can land before thread y+span has read it.
//   Owning the pair is what makes the transform safe in place.
//
// WHY THE BARRIER IS OUTSIDE THE IF
//   WGSL requires workgroupBarrier() to be reached in uniform control flow - every
//   invocation in the workgroup must execute the same barrier. If it sat inside the
//   `j < half` guard, the idle invocations would never reach it; that is undefined
//   behaviour, and on real hardware it is a hang or silent corruption, not an
//   error. So the guard wraps only the butterfly arithmetic and the barrier sits
//   after it, in the stage loop body, whose trip count (uStages) is uniform. Same
//   reason the load loop's barrier is after the loop, not inside it.
//
// SHARED MEMORY
//   Two array<vec4<f32>, LINE> = 2 * 256 * 16 = 8 KiB, inside WebGPU's guaranteed
//   16384-byte maxComputeWorkgroupStorageSize. LINE must be >= N; raise it (and
//   only it) for a larger transform - the loops below are already strided, so they
//   handle N != 256 without further change, though N > 256 also wants more than one
//   element per thread's worth of thought about occupancy.
export const FFT_SHARED_WGSL = /* wgsl */`
// ------------------------------------------------- ported from GLSL COMMON
fn cmul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Reproduces butterflyData()'s rev[]: reverse the low "bits" bits of i.
fn rev(i : u32, bits : u32) -> u32 {
  return reverseBits(i) >> (32u - bits);
}

struct FFTParams {
  uN        : f32,   // resolution
  uStages   : u32,   // log2(N) - butterfly table row stride, and the stage count
  uStage    : u32,   // unused here; kept so both kernels share one uniform block
  uVertical : u32,   // 0 = transform along x (rows), 1 = along y (columns)
  uLayer    : u32,   // cascade index
  _pad0     : u32,
  _pad1     : u32,
  _pad2     : u32,
};

@group(0) @binding(0) var<uniform>             params    : FFTParams;
@group(0) @binding(1) var<storage, read>       butterfly : array<vec4<f32>>;  // stages x N, see header
@group(0) @binding(2) var<storage, read>       src0      : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read>       src1      : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dst0      : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> dst1      : array<vec4<f32>>;

const LINE : u32 = 256u;         // must be >= N
const WG   : u32 = 256u;         // must match @workgroup_size below

var<workgroup> line0 : array<vec4<f32>, LINE>;   // was uSrc0 / o0
var<workgroup> line1 : array<vec4<f32>, LINE>;   // was uSrc1 / o1

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id)         wid : vec3<u32>,
        @builtin(local_invocation_id)  lid : vec3<u32>) {
  let Nu     : u32 = u32(params.uN);
  let stages : u32 = params.uStages;
  let half   : u32 = Nu >> 1u;
  let lane   : u32 = lid.x;
  let ln     : u32 = wid.x;        // which row (uVertical=0) or column (uVertical=1)

  // Walk the transform axis with a stride, so one address expression serves both
  // directions. idx = layer*N*N + y*N + x, therefore:
  //   horizontal: element i of row ln    is base + i * 1
  //   vertical:   element i of column ln is base + i * N
  let layerBase : u32 = params.uLayer * Nu * Nu;
  var base   : u32;
  var stride : u32;
  if (params.uVertical == 0u) {
    base   = layerBase + ln * Nu;
    stride = 1u;
  } else {
    base   = layerBase + ln;
    stride = Nu;
  }

  // ---- load, applying the bit-reversal permutation (see header) --------------
  // Strided so the kernel does not assume N == WG.
  for (var i : u32 = lane; i < Nu; i = i + WG) {
    let srcI : u32 = base + rev(i, stages) * stride;
    line0[i] = src0[srcI];
    line1[i] = src1[srcI];
  }
  workgroupBarrier();

  // ---- log2(N) butterfly stages, in place -----------------------------------
  for (var s : u32 = 0u; s < stages; s = s + 1u) {
    let span : u32 = 1u << s;

    for (var j : u32 = lane; j < half; j = j + WG) {
      // j -> the upper-wing index y of the j-th pair of this stage. The pairs
      // partition 0..N-1, which is why in-place is safe within a stage.
      let y   : u32 = ((j >> s) << (s + 1u)) | (j & (span - 1u));
      let yb  : u32 = y + span;

      // Both twiddles come out of the table rather than one being negated from
      // the other. They ARE each other's negation mathematically (the lower wing's
      // k is larger by N/2), but butterflyData computes cos/sin of both angles in
      // double and rounds each to f32 independently, and for 382 of the 1024 pairs
      // at N=256 the results are not exact negations - the near-zero entries land
      // on +-6.1e-17 with the sign decided by rounding, not by the identity. The
      // difference is numerically irrelevant and bit-visible, and the whole point
      // of this kernel is that it matches the fragment path bit for bit.
      let wt : vec2<f32> = butterfly[y  * stages + s].xy;
      let wb : vec2<f32> = butterfly[yb * stages + s].xy;

      // Same t and b feed both outputs, and both outputs are t + w*b - the wing
      // sign lives in wb. Four complex fields, two per vec4.
      let t0 : vec4<f32> = line0[y];
      let b0 : vec4<f32> = line0[yb];
      let t1 : vec4<f32> = line1[y];
      let b1 : vec4<f32> = line1[yb];

      line0[y]  = vec4<f32>(t0.xy + cmul(wt, b0.xy), t0.zw + cmul(wt, b0.zw));
      line0[yb] = vec4<f32>(t0.xy + cmul(wb, b0.xy), t0.zw + cmul(wb, b0.zw));
      line1[y]  = vec4<f32>(t1.xy + cmul(wt, b1.xy), t1.zw + cmul(wt, b1.zw));
      line1[yb] = vec4<f32>(t1.xy + cmul(wb, b1.xy), t1.zw + cmul(wb, b1.zw));
    }

    // Uniform control flow: every invocation reaches this, including the ones the
    // j-loop gave no work to. See the header.
    workgroupBarrier();
  }

  // ---- store; the last stage's output is already in natural order ------------
  for (var i : u32 = lane; i < Nu; i = i + WG) {
    let dstI : u32 = base + i * stride;
    dst0[dstI] = line0[i];
    dst1[dstI] = line1[i];
  }
}
`;

// The drop-in replacement for FFT_FS is the per-stage kernel: same schedule, same
// dispatch count, same ping-pong. FFT_SHARED_WGSL is the optimisation.
export const FFT_WGSL = FFT_STAGE_WGSL;
