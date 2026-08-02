type KeyboardActivationEvent = {
  key: string;
  target: EventTarget;
  currentTarget: EventTarget;
  preventDefault: () => void;
};

/**
 * Gives a non-native composite control the same Enter/Space activation
 * contract as a button without stealing key events from nested controls.
 */
export function activateOnEnterOrSpace(
  event: KeyboardActivationEvent,
  action: () => void,
): boolean {
  if (event.target !== event.currentTarget) return false;
  if (event.key !== "Enter" && event.key !== " ") return false;
  event.preventDefault();
  action();
  return true;
}
