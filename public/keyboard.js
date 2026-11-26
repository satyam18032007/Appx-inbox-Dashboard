"use strict";

document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.key !== "Enter" || event.isComposing ||
      event.keyCode === 229 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

  const field = event.target;
  if (!field.matches?.('textarea, input:is([type="text"], [type="email"], [type="password"], [type="number"], [type="tel"], [type="url"], [type="search"], :not([type]))') ||
      field.readOnly || field.disabled) return;

  const actionId = field.closest("[data-enter-action]")?.dataset.enterAction;
  const action = actionId ? document.getElementById(actionId) : null;
  const form = field.form;
  const submit = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  const sheetCell = field.matches(".sheet-cell-input");
  if (!action && !submit && !sheetCell) return;

  event.preventDefault();
  if (event.repeat) return;
  if (action && !action.disabled) action.click();
  else if (submit && !submit.disabled) form.requestSubmit(submit);
  else if (sheetCell) field.blur();
});
