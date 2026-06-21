const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function trapFocus(container) {
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
}
