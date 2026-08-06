# EmberChat on your own computer

The desktop app is the same EmberChat, packaged as one download. No
Docker, no server, nothing to configure: install it, add your F-List
account, and you have the whole thing — always-online characters,
catch-up on missed history, Markdown composing, delayed send, highlights
— running on your own machine.

**The honest deal, up front.** What keeps your characters connected to
F-Chat is a program running on *this computer*. Close the window and it
keeps going: the app lives on in the menu bar (macOS) or the
notification area (Windows), and your characters stay online with
nothing on screen. But quit it, shut down, or close the laptop lid, and
your characters go offline like any other chat client. Being online
while your computer is off is the one thing only a server can do — and
if you have one, the desktop app can be its window instead (see [Two
ways to run it](#two-ways-to-run-it) and
[docs/self-hosting.md](self-hosting.md)).

## Download

Both files live on the project's
[releases page](https://github.com/kara-eressea/Ember/releases), beside
the server image, on the same version:

| File | For |
|---|---|
| `EmberChat-<version>-mac-arm64.dmg` | macOS on Apple Silicon (M1 and later) |
| `EmberChat-<version>-win-x64.exe` | Windows 10/11, 64-bit |

There is no Linux build yet, and no Intel Mac build yet — see the
[FAQ](#faq).

## Install on macOS

1. Open the `.dmg` and drag **EmberChat** to your Applications folder.
2. **The first launch only**: find it in Applications, **right-click**
   (or Control-click) it and choose **Open**, then **Open** again in the
   dialog that appears.

That second step is not optional and it is not a mistake. The app is not
signed with an Apple Developer certificate, so a plain double-click gets
you *"EmberChat cannot be opened because the developer cannot be
verified"* with no obvious way past it — macOS only offers the "open it
anyway" button on the right-click route. You do this **exactly once**:
after that, macOS remembers, and every later launch is an ordinary
double-click or Dock click.

The first launch also takes a minute or so with nothing on screen while
the app sets itself up. The menu-bar icon appears first and says
*Starting up…*; the window follows.

## Install on Windows

1. Run the downloaded `.exe`.
2. Windows SmartScreen says *"Windows protected your PC"*. Click **More
   info**, then **Run anyway**. Same reason as macOS: the installer is
   not signed, so Windows has no publisher to name.
3. Take the default install location or pick your own, and finish.

The app installs **for your user account only**. There is no
administrator prompt at any point, and you do not need admin rights. An
unsigned installer asking for elevation is exactly the shape of thing
you should refuse — if this one ever does, something is wrong and we'd
like to hear about it.

## Two ways to run it

The first launch asks which you want. Both are ordinary uses of the app;
you can change your mind later.

**Use locally.** Everything runs on this computer — the client, the
server part that holds your F-Chat connections, and your conversation
history. Nothing to set up, nothing to maintain, and no traffic to
anywhere except F-List. This is the one most people want, and the honest
deal above is its whole caveat.

**Connect to my server.** For people who *already* run EmberChat on a
server of their own. The app becomes a window onto that instance: your
characters stay connected and your conversations are kept over there, so
nothing goes offline when this computer sleeps. You sign in with your
account on that server, exactly as you would in a browser.

This mode needs an instance you have already set up —
[docs/self-hosting.md](self-hosting.md) is how that is done. It cannot
create one for you. Two things to expect when you enter the address:

- **`https://` is required**, and the certificate has to be one your
  operating system already trusts. A self-signed certificate is refused
  outright, by name (`ERR_CERT_AUTHORITY_INVALID` and friends), with no
  "proceed anyway" — there deliberately isn't one, because your F-List
  password travels this connection. (`http://` is accepted for
  `localhost` and `127.0.0.1` only.)
- **The address is checked before anything loads**, so a typo tells you
  it is the wrong address rather than leaving you to guess whether your
  server is down.

**Switching later** is one menu item: **Switch mode…**, in the EmberChat
menu on macOS and the File menu on Windows. The app restarts into the
mode you picked. Switching away from local mode **never deletes your
local data** — pick "Use locally" again and everything is where you left
it.

## Closing, quitting, and the tray

In **local mode**, closing the window hides it; the app keeps running in
the menu bar / notification area and your characters stay online. The
first time this happens you get a one-time notice saying so, because a
chat app that closes without going offline is not what your other apps
have taught you to expect.

From that icon: **Open** brings the window back (so does clicking the
icon, or the Dock icon on macOS), and **Quit** is the real goodbye — it
disconnects your characters and exits.

In **connect-to-my-server** mode, closing the window quits the app. There
is no local connection to keep alive, and your server carries on
regardless.

## Where your data lives

Everything the app keeps about you is in one folder:

| Platform | Folder |
|---|---|
| macOS | `~/Library/Application Support/EmberChat` |
| Windows | `%APPDATA%\EmberChat` (i.e. `C:\Users\<you>\AppData\Roaming\EmberChat`) |

Inside it:

- `db/` — your conversations. This is the whole history the app has.
- `config.json` — which mode you chose, and the server address if you
  chose the second one. Plain text, and safe to read; if it is ever
  damaged the app just asks you to choose again.
- `secrets.json` — the app's own keys for your machine, encrypted by the
  operating system (Keychain on macOS, DPAPI on Windows). There is no
  plaintext fallback: if the OS can't encrypt, the app says so and stops
  rather than writing your secrets in the clear.

**Your F-List password is not in there.** As on a self-hosted server, it
lives in memory only for as long as the app is running — so every
restart asks for it again before your characters reconnect. That is the
trade the project makes by default, and the desktop app makes it too.

### Backing up

**Quit the app first, then copy the folder.** Both halves matter. A copy
taken while the app is running can look perfectly fine — it will open,
it will even accept writes — and still be missing the write that was in
flight; a database file copied out from under a running program is not a
backup, whatever it looks like afterwards. Quit from the tray, copy the
folder somewhere else, done. Restoring is the same in reverse: quit,
put the folder back.

One durability note, stated rather than implied: the embedded database
is tuned for a personal machine and does not wait for the disk on every
message. If the power goes out or you force-restart, you can lose the
last few seconds of conversation. The database itself survives that —
the failure mode is "lose the newest handful of lines", not "lose
everything". A normal quit, or even the app crashing, costs you nothing.

### Uninstalling

**Uninstalling leaves your data behind, on purpose.** Removing the app
on either platform never touches the folder above, so reinstalling later
picks up exactly where you left off. Parting with your history should be
something you *decide*, not something an uninstaller does on your
behalf.

So if you do want it gone: uninstall the app, then delete that folder
yourself.

## Updating

**There is no auto-updater.** Nothing downloads or installs itself
behind your back.

What you get instead is the same release check the server has: the
version number sits at the top of the sidebar (and under Preferences →
General), and once a day the app asks GitHub whether there is a newer
release. When there is, that version number tints and becomes a link to
the releases page. No banners, no nagging.

To update, download the new file and install it over the old one — drag
to Applications and replace on macOS, run the new installer on Windows.
Your data folder is separate from the app itself, so your history,
settings and mode survive untouched, and you stay signed in.

## FAQ

**Why does my computer warn me about it?**
Because it is unsigned. Code signing means buying an identity — an Apple
Developer certificate on macOS, a certificate from a vendor Microsoft's
root program trusts on Windows — and paying for it every year. That is a
deliberate deferral for a project this size, not an oversight, and the
build is configured so it can be turned on the day it is worth doing.
The warnings you see are your OS telling you the truth: it does not know
who made this. The mitigation available to you is the ordinary one —
download it from the project's own releases page, and nowhere else.

If you want to check that a download arrived intact, each release also
carries a `checksums.txt` with the SHA-256 of every installer. Compare
against the file you downloaded — on a Mac, in Terminal, from your
Downloads folder:

    shasum -a 256 -c checksums.txt --ignore-missing

and on Windows, in PowerShell:

    Get-FileHash .\EmberChat-*.exe

then compare the printed hash with the matching line in `checksums.txt`.

**Why is there no Intel Mac build?**
Parts of the app are compiled rather than interpreted, and they are
compiled on the machine that packages the build — so a build can only
produce the architecture it was made on, and the machine that makes the
Mac build is Apple Silicon. It is not a judgment about Intel Macs; it is
one more build machine. Ask if you need one. (Rosetta doesn't help here:
it translates Intel apps for Apple Silicon, not the other way round.)

**Why is there no Linux build?**
It was scoped out of the first release, not designed out. Nothing in the
app is macOS/Windows-specific — the tray already knows what to do on
Linux. Ask if you want one.

**Does it work offline?**
Not usefully — it is a chat client, and with no connection there is
nobody to talk to. In local mode the app still opens and the history
already on your machine is still there to read; nothing new arrives and
nothing you write goes anywhere until you are back online. In
connect-to-my-server mode there is nothing to show at all: the app is a
window onto a machine it cannot reach.

**Can I use the desktop app *and* my own server?**
Yes — that is exactly what "Connect to my server" is for. Run the server
so your characters are online while your computer is off, and use the
desktop app as its window. You can also keep using a browser against the
same server; they are the same app either way.

**Something went wrong — what do I send with a bug report?**
Every error the app shows ends with a `Details:` line (an exit code, an
error name, a file path). That line is the useful part — include it
verbatim. If you can reproduce the problem, launching the app from a
terminal shows the startup log as well, which says which mode it chose
and what the local server did:

```sh
# macOS
/Applications/EmberChat.app/Contents/MacOS/EmberChat
```

```
:: Windows — from the install folder, by default
::   %LOCALAPPDATA%\Programs\EmberChat
EmberChat.exe
```

Conversation history itself is exportable from inside the app
(Preferences → Away & logs) as text, HTML or JSON — useful for keeping
a log, and worth checking before you report anything that would mean
sending one.
