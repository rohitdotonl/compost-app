// All user-facing copy for the extension. Same tone as public/strings.js;
// the receipt, rack-full and intent wording is copied from there verbatim.
export const S = {
  appName: 'Compost',

  // Receipt (same as the Save page)
  saving: 'Saving…',
  savedReceipt: (used, limit, weekday) => `Slot ${used} of ${limit} used. Expires ${weekday}.`,
  intentQuestion: 'When will you read it?',
  intents: { tonight: 'Tonight', commute: 'Commute', weekend: 'Weekend' },
  alreadyInRack: 'Already in your rack',
  alreadyInVault: 'Already in your vault',
  rackFull: 'Your rack is full. Drop one to make room.',
  dropAndSave: 'Drop and save',
  cancel: 'Cancel',
  nothingSaved: 'Nothing saved.',
  invalidLink: 'That doesn’t look like a link.',
  notAPage: 'This isn’t a page Compost can save.',
  openRack: 'Your rack',

  // The optional one-line "why"
  notePlaceholder: 'Why this one? (optional)',
  noteSaved: 'Noted.',

  // Setup
  notSetUp: 'Tell the extension where your Compost lives.',
  openOptions: 'Open settings',
  passcodeWrong: 'That passcode didn’t work.',
  noPermission: 'The extension isn’t allowed to reach that address yet.',

  // Options page
  optionsTitle: 'Compost settings',
  addressLabel: 'Compost address',
  addressHint: 'The address you open the app at, like https://compost.example.workers.dev',
  passcodeLabel: 'Passcode',
  save: 'Save',
  testConnection: 'Test connection',
  testing: 'Checking…',
  connected: 'Connected.',
  invalidAddress: 'That doesn’t look like an address.',
  permissionDenied: 'Without permission for that address, the extension can’t save.',
  shortcutNote: 'Alt+Shift+S saves the current tab. Change it at chrome://extensions/shortcuts.',

  // Context menu
  menuSaveLink: 'Save link to Compost',
  menuSavePage: 'Save page to Compost',

  // Badge text (keep to a few characters)
  badgeInRack: '•',
  badgeInVault: '✓',
  badgeSaved: 'ok',
  badgeFull: 'full',
  badgeFailed: '!',

  // Errors
  offline: 'Couldn’t reach Compost. Try again.',
  retry: 'Try again',
  somethingWrong: 'Something went wrong.',
};
