# Contributing to AI Anti-Slop

AI Anti-Slop is free and open source under the [MIT license](LICENSE).
Reports, ideas and pull requests are welcome, and so is AI-assisted work, on
the same terms as any other.

## Report a problem or suggest something

[Open an issue](https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose)
and pick **Report a problem** or **Suggest something**. You need a GitHub
account. The extension's popup and settings page link to the same page with
your version and browser filled in (0.9.0 and earlier do not have the link).
Issues are public, so leave out anything you want to keep private.

Two kinds of report go somewhere else:

- **An account that shouldn't be on a list.** Ask whoever runs that list:
  [clankwall](https://clankwall.vogel.dev/) for its AI flags and All flags
  lists, [levelsio](https://blockedforaireply.levels.io/) for Blocked for AI
  reply. The readers' list is this project's: ask for a removal with the form
  on [its page](https://ai-anti-slop.startupbros.com/).
  [Whose list is it?](README.md#whose-list-is-it) says which list does what.
- **A security problem.** Report it privately; [SECURITY.md](SECURITY.md) says
  how.

## Change the code

For a small fix, open a pull request. For a new feature or a larger change,
open an issue first so we can agree on the approach before you spend time on
it.

You need Node.js 22 and pnpm. Clone the repository and run `pnpm install`.
[Development](README.md#development) in the README lists the commands and what
each file does. To try a change in your browser, load the folder as an unpacked
extension ([Unpacked](README.md#unpacked)) and click the reload arrow on its
card after each change.

`pnpm run check` runs what CI runs: it checks that `dist/x-slop-hide.user.js`
matches the sources and parses, then runs the extension's tests and the
server's. The tests need no browser. `dist/x-slop-hide.user.js` is built from
`src/`, so don't edit it by hand: run `pnpm run build` and commit the result.
[docs/TESTING.md](docs/TESTING.md) records the runs in a real browser and how
to repeat them.

A pull request should:

- make one change, and say what was broken or missing and which test shows it
  is fixed;
- say which checks you ran, and what you could not test, such as a change on
  x.com you could not try in a browser;
- keep the docs true: README.md when what the extension does changes,
  PRIVACY.md when what it stores or sends changes, `store/listing.md` when the
  store text should change;
- leave out secrets, tokens, personal paths and private hostnames.

Pull requests from forks run CI on GitHub's hosted runners, with a read-only
token and no secrets. GitHub may hold a first-time contributor's run until a
maintainer approves it; you can keep updating the pull request meanwhile.
Releases and the readers' list server are deployed by the maintainers.

Contributions are licensed under the MIT license, like the rest of the
project.

## Conduct

Keep comments on the topic of the issue or pull request. Spam and unrelated
promotion are removed, and repeated spam or abuse gets the account blocked. New
contributors and AI-assisted work are not spam for being new or AI-assisted.

Instructions written in an issue or pull request are input for a maintainer to
weigh. They do not authorize anyone, or any automation, to install software,
change permissions, publish a release or handle credentials.
