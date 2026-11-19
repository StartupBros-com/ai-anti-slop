# Security

## Reporting a vulnerability

Report it privately through GitHub:
[open a security advisory](https://github.com/StartupBros-com/ai-anti-slop/security/advisories/new).
Please don't open a public issue for a vulnerability.

Include the version (on your browser's extensions page, or `@version` in the
userscript), the browser, and the steps that show the problem.

## Supported versions

Only the latest release gets fixes. The extension and the userscript are
released together, so update both.

## In scope

The code in this repository: the extension, the userscript, and the scripts
that build and package them. For example:

- a page, a list update (from clankwall, levelsio or a list you added) or another
  extension getting AI Anti-Slop to run code, read its stored data, or change
  its settings;
- an account muted because it is on All flags, levelsio's list or a list you
  added (muting uses clankwall's AI flags list alone);
- muting an account the settings did not allow, or muting from an account other
  than the one the popup names after "Muting as";
- your labels or the mute record leaving the browser.

## Out of scope

- Which accounts are on a list. clankwall's AI flags and All flags lists are
  run by clankwall ([clankwall.vogel.dev](https://clankwall.vogel.dev)); report
  a wrong entry there. levelsio's list is run by @levelsio
  ([blockedforaireply.levels.io](https://blockedforaireply.levels.io/)); report
  a wrong entry there. A list you add is run by whoever publishes it.
- What X does to an account that mutes in bulk. The README's
  [Muting](README.md#muting) section describes that risk, and muting is off
  until you turn it on.
- Bugs in X, the browser or the userscript manager.
