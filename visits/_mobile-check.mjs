export default async function (v) {
  await v.wait(5000);
  await v.shot('arrival-panel-should-be-closed');
  const t = await v.visibleText();
  v.note('hud: ' + JSON.stringify(t.hud));
  const state = await v.eval(() => ({
    bodyHidden: document.body.classList.contains('panel-hidden'),
    uiRect: document.getElementById('ui').getBoundingClientRect().toJSON(),
    btn: document.getElementById('panel-toggle')?.getBoundingClientRect().toJSON(),
    btnText: document.getElementById('panel-toggle')?.innerText,
    expanded: document.getElementById('panel-toggle')?.getAttribute('aria-expanded'),
  }));
  v.note('state: ' + JSON.stringify(state));
  await v.click('#panel-toggle');
  await v.wait(2500);
  await v.shot('panel-open-as-bottom-sheet');
  const open = await v.eval(() => {
    const r = document.getElementById('ui').getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), vh: window.innerHeight,
             visibleOceanPx: Math.round(r.top) };
  });
  v.note('open sheet: ' + JSON.stringify(open));
  await v.click('#panel-toggle');
  await v.wait(2000);
  await v.shot('closed-again');
}
