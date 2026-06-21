// Touch-friendly stand-in for shift-click grouping on coarse pointers.

export function createModifierZone(container, { onToggle, signal } = {}) {
  let active = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'modifier-zone';
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', 'Group mode — tap pieces to add or remove from selection');
  button.innerHTML = '<span class="modifier-zone-key" aria-hidden="true">⇧</span><span class="modifier-zone-label">Group</span>';

  const setActive = (on) => {
    active = !!on;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    container.classList.toggle('group-modifier-on', active);
    onToggle?.(active);
  };

  button.addEventListener('click', () => {
    setActive(!active);
    navigator.vibrate?.(active ? 10 : 6);
  }, { signal });

  container.appendChild(button);

  return {
    isGroupModifier(event) {
      return !!(event?.shiftKey || event?.ctrlKey || event?.metaKey || active);
    },
    isActive() { return active; },
    setActive,
    destroy() {
      setActive(false);
      button.remove();
    }
  };
}

export function coarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 640px)').matches;
}
