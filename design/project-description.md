# Project

# Purpose

A group of friends, including myself, often spend time role-playing on F-List (specifically F-Chat), but all find the official chat client pretty poor. It does what it's supposed to, but there are features that we miss that we've gotten used to from modern clients, such as, but not limited to:

* Staying online, even if we close the app down.
* Catching up on conversations when we log back on.
* Using Markdown in conversations instead of BBCode that can't be previewed while typing. *We are aware that the server still only accepts BBCode, so this might need a translation layer when the message is in-flight.*
* Editing messages. *Because this is closer to IRC, we can't actually edit messages, but the client could be configured to hold the message back for X amount of seconds, so you can still press ArrowUp before those have passed to pause it and edit it.*
* Being logged in from multiple places.
* More granular highlight rules.



# Architecture

This is mostly brainstorming, and this is something I'd like pushback on.

* The primary workhorse of this is obviously a chat client, but on top of that, I'd want multi-user accounts for the site itself, where you can then add multiple F-List accounts to, if needed.
* Primarily web-based app.
* Use some form of programming language that could also be spun out to an Electron app later down the line.
* The app should be able to run in a Docker container. 
* The app should use a durable database, like Postgres.
* How do I avoid the client slowing down as chat history keeps growing? 
* Client and server should likely be separate (also to support the previous note on a desktop app).
* Should support all the features that F-Chat does in version 1.0. The source code is available here: https://github.com/f-list/chat3client
* Protocol: see: protocol.md
* Client commands: see: client-commands.md
* Server commands: see: server-commands.md



# UI design

* See Claude Design files. README and COMPONENTS inside `design/ui`. 
* Prototype and mockup in `/prototype`
* Translate, don't transliterate. 



# F-Chat's Developer Policy

## Client Requirements

In addition to the requirements for all software: 

* On connection to F-Chat, your client must uniquely identify itself as apart from an official client, and this includes both a client name and version.
* Your client must support and send text formatting as well-structured BBCode, and must not support BBCode tags which are not supported by official clients. In the same vein, the syntax for users to enter smilies and commands should be consistent or very similar to the syntax of official clients.
* Your client must use server resources responsibly and intelligently; do not spam API requests, stagger re-connection attempts (with a reasonable time-out, 10 second minimum), do not spam commands to the server or wilfully send garbage. 
* Your client must not store, transmit, upload, or otherwise tamper with or log with a user's information. Your client is allowed to log messages and commands received, but the location of these logs must be known and readily accessible to the user.
* Your client should not crash upon receiving any command, even one it does not know. Unknown commands should be either logged for debugging or swallowed. 
* If possible, your client should implement rudimentary administration tools.
