/* Reading gestures never consume scrolling inside long text or button actions. */
export function installReadingGestures(stage) {
  const node = stage.node;
  let gesture = null, timer = 0, suppressClick = false;
  const clear = () => { clearTimeout(timer); timer = 0; gesture = null; };
  const down = event => {
    if (stage.paused || stage.ended || event.button > 0 || event.target.closest('button,input,textarea,select,.text.is-scrollable')) return;
    clear(); suppressClick = false;
    gesture = { x: event.clientX, y: event.clientY, moved: false, held: false };
    timer = setTimeout(() => {
      if (!gesture || gesture.moved || stage.paused || !stage.mounted) return;
      gesture.held = true; suppressClick = true;
      node.classList.toggle('ui-hidden');
    }, 450);
  };
  const move = event => {
    if (!gesture) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12) { gesture.moved = true; clearTimeout(timer); }
  };
  const up = event => {
    if (!gesture) return;
    const dy = event.clientY - gesture.y, dx = event.clientX - gesture.x;
    if (!gesture.held && dy < -48 && Math.abs(dy) > Math.abs(dx) * 1.5 && !stage.paused) {
      suppressClick = true; stage.opts.onJournal?.();
    }
    clear();
  };
  const click = event => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } };
  const menu = event => { if (gesture?.held || suppressClick) event.preventDefault(); };
  for (const [type, handler, capture] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', clear], ['pointerleave', clear], ['click', click, true], ['contextmenu', menu]]) node.addEventListener(type, handler, !!capture);
  return () => {
    clear();
    for (const [type, handler, capture] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', clear], ['pointerleave', clear], ['click', click, true], ['contextmenu', menu]]) node.removeEventListener(type, handler, !!capture);
  };
}
