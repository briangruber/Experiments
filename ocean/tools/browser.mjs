// Finding a Playwright that can actually launch.
//
// Resolving the module is not the same as being able to start a browser: a
// Playwright installed from npm expects a browser build matching its own version,
// and an environment that already ships browsers (CI images, sandboxes) usually
// has a different one. Resolving succeeds and launching then fails with a missing
// executable, which reads like a broken test rather than a broken install.
//
// So: try each candidate by actually launching it, and keep the first that works.

const CANDIDATES = [
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs',
  process.env.PLAYWRIGHT_PATH,
].filter(Boolean);

export const GL_ARGS = [
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  // WebGPU is off by default in headless Chromium. Without these,
  // requestAdapter() returns null and a page cannot tell "this browser has no
  // WebGPU" from "this launch did not ask for it".
  '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU',
];

export async function launchChromium(opts = {}) {
  const failures = [];
  for (const c of CANDIDATES) {
    let mod;
    try {
      mod = await import(c);
    } catch (e) {
      failures.push(`${c}: not resolvable`);
      continue;
    }
    try {
      return await mod.chromium.launch({ args: GL_ARGS, ...opts });
    } catch (e) {
      failures.push(`${c}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error(
    'could not launch Chromium through Playwright.\n  ' + failures.join('\n  ') +
    '\nInstall browsers with `npx playwright install chromium`.',
  );
}
