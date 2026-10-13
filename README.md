# MyTimeLogger

A **Time Logger** panel for [myProtime](https://efrag.myprotime.eu/) for logging day status and project
time for a whole week in a few clicks. It runs as a browser bookmark: nothing to install, no extension,
no passwords or tokens to enter. It works in Edge, Chrome and Firefox.

## Install (once)

1. Open **install.html** in your browser:
   - from this repository: open `install.html`, click *Download raw file* and open the downloaded file, or
   - from the link shared by a colleague.
2. Show the bookmarks bar with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (in Edge: favourites bar).
3. Drag the blue **Time Logger** button from the page onto the bookmarks bar.

If dragging does not work, install.html also shows the bookmark text to copy and paste into a manually
created bookmark.

## Use

1. Open https://efrag.myprotime.eu/ and log in as usual.
2. Click **Time Logger** in the bookmarks bar. The panel opens at the bottom right; clicking the bookmark
   again hides it. After reloading the myProtime page, click the bookmark again.
3. Choose a tab, click **Preview**, check the planned actions and click **Execute**.

| Tab | What it does |
|---|---|
| Overview | Shows status and logged project time for each day in a range. |
| Log range | Logs one project for every working day in a range (e.g. a full week), using your scheduled hours unless you enter hours (`7:30` or `7.5`). |
| Copy day | Copies all project entries of one day to every working day in a range. |
| Day status | Sets Working, Vacation, Teleworking, … for every weekday in a range, optionally replacing an existing status. |

Nothing is changed before you click **Execute**. Weekends, public holidays, locked days and days with an
absence are skipped. Days without a status are set to *Working* first (can be switched off). Days that
already have logged time are skipped unless *Replace time already logged* is ticked.

Deleting time in myProtime creates a removal request; if it needs approval, the old entry stays visible
until it is approved.

## Updating

When a new version is released, delete the old **Time Logger** bookmark and install the new one from
install.html. The version is shown at the top of install.html.

## For maintainers

- `mytimelogger.user.js` is the only source file.
- After changing it, increase `@version` and run `.\build.ps1` (PowerShell, no other tools needed) to
  regenerate `install.html` from `install.template.html`. Commit both files.
- `mytimelogger.user.js` can also be installed directly as a userscript (e.g. Tampermonkey), which shows the
  Time Logger button on every myProtime page without clicking a bookmark.
- The tool uses the same internal requests as the myProtime website (`/api/...`, `/bff/...`) with the
  user's own session. The official [ProTime API](https://documentation.myprotime.eu/protimeapi/) only
  offers company-level client credentials and cannot write activity durations or absence requests.
  If myProtime changes its requests, record a HAR in the browser's developer tools (Network tab →
  *Save all as HAR*) while doing the action manually, and update the `protime` object in the script.
  HAR files contain your session and are excluded by `.gitignore`; never commit or share them.
