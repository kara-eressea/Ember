<div style="float:right;margin:10px;">__TOC__</div>
==Commands sent by client==

{{Command
|cmd = ACB
|restriction = chatop
|desc = Request a character's account be banned from the server.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = AOP
|restriction = adminonly
|desc = Promotes a user to be a chatop (global moderator).
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = AWC
|restriction = chatop
|desc = Requests a list of currently connected alts for a characters account.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = BRO
|restriction = adminonly
|desc = Broadcasts a message to all connections.
|type = client
|syntax = { "message": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = CBL
|restriction = chanop
|desc = Request the channel banlist.
|type = client
|syntax = { "channel": string }
|sample = CBL {"channel":"ADH-c7fc4c15c858dd76d860"}
|prams = 
|notes = This command does not have a unique response command from the server; A response is sent as SYS. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CBU
|restriction = chanop
|desc = Bans a character from a channel.
|type = client
|syntax = {"character": string, "channel": string}
|sample = CBU {"character":"Pas un Caractere","channel":"ADH-c7fc4c15c858dd76d860"}
|prams = channel: The channel from which the character is being banned.

character: The character being banned.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CCR
|desc = Create a private, invite-only channel.
|type = client
|syntax = { "channel": string }
|sample = CCR {"channel":"test"}
|prams = 
|notes = The channel param is used as the title for the newly created channel, not the actual channel name used to join the channel. The server will send the channel's actual ID in response.
}}

{{Command
|cmd = CDS
|restriction = chanop
|desc = Changes a channel's description.
|type = client
|syntax = { "channel": string, "description": string }
|sample = CDS {"description": "[color=red]No actual roleplay in here. For discussion of anything at all, please go to the correct channels.[/color]
This is the channel for RP offers and announcements.", "channel": "Looking for RP"}
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CHA
|desc = Request a list of all public channels.
|type = client
|syntax = 
|sample = 
|prams = 
|notes = This is an argumentless command.
}}

{{Command
|cmd = CIU
|restriction = chanop
|desc = Sends an invitation for a channel to a user.
|type = client
|syntax = { "channel": string, "character": string }
|sample = CIU {"character":"Testytest", "channel":"ADH-011aeb5bb591b1f4721a"}
|prams = 
|notes = This command does not have a unique response command from the server; a response is sent as SYS. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CKU
|restriction = chanop
|desc = Kicks a user from a channel.
|type = client
|syntax = { "channel": string, "character": string }
|sample = 
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = COA
|restriction = chanop
|desc = Request a character be promoted to channel operator (channel moderator).
|type = client
|syntax = { "channel": string, "character": string }
|sample = 
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = COL
|desc = Requests the list of channel ops (channel moderators).
|type = client
|syntax = { "channel": string }
|sample = 
|prams = 
|notes = This command does not have a unique response command from the server; A response is sent as SYS.  As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = COR
|restriction = chanop
|desc = Demotes a channel operator (channel moderator) to a normal user.
|type = client
|syntax = { "channel": string, "character": string }
|sample = 
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CRC
|restriction = adminonly
|desc = Creates an official channel.
|type = client
|syntax = { "channel": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = CSO
|restriction = chanop
|desc = Set a new channel owner.
|type = client
|syntax = {"character":"string","channel":"string"}
|sample = CSO {"character":"Jinni Wicked","channel":"ADH-3875a3c8c11325b49992"}
|prams = 
* character: the character to set as owner
* channel: which channel to set the owner in
|notes = This command is only implemented in F-Chat 1.0, at the time of this writing. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CTU
|restriction = chanop
|desc = Temporarily bans a user from the channel for 1-90 minutes. A channel timeout.
|type = client
|syntax = { "channel":string, "character":string, "length":num }
|sample = CTU {"channel":"Frontpage", "character":"Treebob", "length":"30"}
|prams = 
* channel: the channel from which to remove the character
* character: the character to timeout
* length: the time, in minutes, to keep the character out of the room
|notes = I have no idea how the server replies. Someone should probably grab me some logs.
}}

{{Command
|cmd = CUB
|restriction = chanop
|desc = Unbans a user from a channel.
|type = client
|syntax = { channel: "channel", character: "character" }
|sample = 
|prams = 
|notes = This command does not have a unique response command from the server; A response is sent as SYS. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = DOP
|restriction = adminonly
|desc = Demotes a chatop (global moderator).
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = FKS
|desc = Search for characters fitting the user's selections. Kinks is ''required'', all other parameters are optional.
|type = client
|syntax = { "kinks": [int], "genders": [enum], "orientations": [enum], "languages": [enum], "furryprefs": [enum], "roles": [enum] }
|sample = FKS {"kinks":["523","66"],"genders":["Male","Maleherm"], "orientations":["Gay","Bi - male preference","Bisexual"], "languages":["Dutch"], "furryprefs":["Furs and / or humans","Humans ok, Furries Preferred","No humans, just furry characters"], roles:["Always dominant", "Usually dominant"] }
|prams = kinks: identified by kinkids, available [http://www.f-list.net/json/chat-search-getfields.json?ids=true here], along with the full list of other parameters. <br />genders: can be any of "Male", "Female", "Transgender", "Herm", "Shemale", "Male-Herm", "Cunt-boy", "None"<br />orientations: can be any of "Straight", "Gay", "Bisexual", "Asexual", "Unsure", "Bi - male preference", "Bi - female preference", "Pansexual", "Bi-curious"<br />languages: can be any of "Dutch", "English", "French", "Spanish", "German", "Russian", "Chinese", "Japanese", "Portuguese", "Korean", "Arabic", "Italian", "Swedish", "Other"<br />furryprefs: can be any of "No furry characters, just humans", "No humans, just furry characters", "Furries ok, Humans Preferred", "Humans ok, Furries Preferred", "Furs and / or humans"<br />roles: can be any of "Always dominant", "Usually dominant", "Switch", "Usually submissive", "Always submissive", "None"
|notes = 
}}

{{Command
|cmd = IDN
|desc = This command is used to identify with the server.
|type = client
|syntax = { "method": "ticket", "account": string, "ticket": string, "character": string, 
"cname": string, "cversion": string }
|sample = 
|prams = Ticket: A ticket can be aquired using the JSONP endpoint, see the JSON endpoints section of the documentation for details.<br/>
cname: The client's identifying name.<br/>
cversion: The client's identifying version
|notes = If you send any commands before identifying, you will be disconnected. 
}}

{{Command
|cmd = IGN
|desc = A multi-faceted command to handle actions related to the ignore list. The server does not actually handle much of the ignore process, as it is the client's responsibility to block out messages it recieves from the server if that character is on the user's ignore list.
|type = client
|syntax = { "action": enum, "character": string }
|sample = IGN {"action": "add", "character": "Teal Deer"}<br /> IGN{"action": "delete", "character": "Teal Deer"}<br /> IGN{"action": "notify", "character": "Teal Deer"}<br /> IGN{"action": "list"}
|prams = action
*add: adds the character to the ignore list
*delete: removes the character from the ignore list
*notify: notifies the server that character sending a PRI has been ignored
*list: returns full ignore list. Does not take 'character' parameter.
|notes = 
}}

{{Command
|cmd = JCH
|desc = Send a channel join request.
|type = client
|syntax = { "channel": string }
|sample = JCH {"channel": "Frontpage"}
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = KIC
|restriction = chatop
|desc = Deletes a channel from the server.
|type = client
|syntax = { "channel": string }
|sample = 
|prams = 
|notes = Private channel owners can destroy their own channels, but it isn't officially supported to do so.
}}

{{Command
|cmd = KIK
|restriction = chatop
|desc = Request a character be kicked from the server.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = KIN
|desc = Request a list of a user's kinks.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = This information can also be acquired from a JSON endpoint.
}}

{{Command
|cmd = LCH
|desc = Request to leave a channel.
|type = client
|syntax = { "channel": string }
|sample = 
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = LRP
|desc = Sends a chat ad to all other users in a channel.
|type = client
|syntax = { "channel": string, "message": string }
|sample = LRP {"message": "Right, evenin'", "channel": "Frontpage"}
|prams = 
|notes = If you send more than one ad per ten minutes the message will not be sent, and an ERR will be returned. At this time of writing, there is a maximum length for LRP messages of 50000 bytes (effectively 50000 characters). You should however rely on VAR messages from the server to get the correct limit on your client. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = MSG
|desc = Sends a message to all other users in a channel.
|type = client
|syntax = { "channel": string, "message": string }
|sample = MSG {"message": "Right, evenin'", "channel": "Frontpage"}
|prams = 
|notes = If you send more than one message a second the message will not be sent, and an ERR will be returned. At this time of writing, there is a maximum length for MSG messages of 4096 bytes (effectively 4096 characters). You should however rely on VAR messages from the server to get the correct limit on your client. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = ORS
|desc = Request a list of open private rooms.
|type = client
|syntax = 
|sample = 
|prams = 
|notes = This is an argumentless command.
}}

{{Command
|cmd = PIN
|desc = Sends a ping response to the server. Timeout detection, and activity to keep the connection alive.
|type = client
|syntax = 
|sample = 
|prams = 
|notes = You have to respond to pings or you will be disconnected, as that will be detected as a timeout. The server will try to get a ping response three times, each time waiting 30 seconds. So if you don't respond, you will be disconnected after 90 seconds. Sending multiple pings within ten seconds will get you disconnected also. This is an argumentless command.
}}

{{Command
|cmd = PRI
|desc = Sends a private message to another user.
|type = client
|syntax = { "recipient": string, "message": string }
|sample = 
|prams = 
|notes = There is flood control; the same as the MSG command. At this time of writing, the maximum length of a private message is 50000 bytes (effectively characters).
}}

{{Command
|cmd = PRO
|desc = Requests some of the profile tags on a character, such as Top/Bottom position and Language Preference.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = This information can also be acquired from a JSON endpoint.
}}

{{Command
|cmd = RLL
|desc = Roll dice or spin the bottle.
|type = client
|syntax = { "channel": string, "dice": string }
|sample = RLL {"channel":"ADH-dce8eb7af86213ac4c15","dice":"bottle"} <br />
RLL {"channel":"ADH-dce8eb7af86213ac4c15","dice":"9d100"}<br />
RLL {"channel":"ADH-c7fc4c15c858dd76d860","dice":"1d6+1d20"}<br />
RLL {"channel":"ADH-c7fc4c15c858dd76d860","dice":"1d6+10000"}<br />
|prams = channel: Which channel the command is being used in

dice:
* bottle: selects one person in the room, other than the person sending the command.
* #d##: rolls # dice with ## sides, each.
* #d##+#d##: rolls more than one size of dice.
* #d##+###: adds a number (###) to the roll.
|notes = # can be any number 1-9. ## can be any number 1-500. ### can be any number up to 10000. It is possible to add up to 20 sets of dice and/or numbers. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = RLD
|restriction = chatop
|desc = Reload certain server config files
|type = client
|syntax = { "save": string }
|sample = 
|prams = 
|notes = Somebody who can actually use this command please correct this, and add the server response, if there is one?
}}

{{Command
|cmd = RMO
|restriction = chanop
|desc = Change room mode to accept chat, ads, or both.
|type = client
|syntax = {"channel": string, "mode": enum}
|sample = RMO {"channel": "ADH-c7fc4c15c858dd76d860" ,"mode": "chat"}
|prams = channel: Which channel is being changed.

mode:
* chat: Show only MSG.
* ads: Show only LRP.
* both: Show MSG and LRP.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = RST
|restriction = chanop
|desc = Sets a private room's status to closed or open. (private|open, private|closed)
|type = client
|syntax = { "channel": string, "status": enum }
|sample = >>RST {"channel":"ADH-06c3db8a4789498d6ae8","status":"public"}
|prams =
* channel: this should be the channel id
* status: this can be 'public' or 'private'
|notes = This command does have a unique response command from the server. 
}}

{{Command
|cmd = RWD
|restriction = adminonly
|desc = Rewards a user, setting their status to 'crown' until they change it or log out.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes =
}}

{{Command
|cmd = SFC
|desc = Alerts admins and chatops (global moderators) of an issue.
|type = client
|syntax = { "action": "report", "report": string, "character": string }
|sample = 
|prams = action: the type of SFC. The client will always send "report".<br/>
report: The user's complaint<br/>
character: The character being reported
|notes = The webclients also upload logs and have a specific formatting to "report". It is suspected that third-party clients cannot upload logs.
}}

{{Command
|cmd = STA
|desc = Request a new status be set for your character.
|type = client
|syntax = { "status": enum, "statusmsg": string }
|sample = STA {"status": "looking", "statusmsg": "I'm always available to RP :)", "character": "Hexxy"}
|prams = Status: Valid values are "online", "looking", "busy", "dnd", "idle", "away", and "crown".
|notes = Crown is a special value, and should not be sent by a client, as it is set by the RWD command. Idle is an automatic status set by some clients, when the user has not interacted with the client for a certain amount of time.
}}

{{Command
|cmd = TMO
|restriction = chatop
|desc = Times out a user for a given amount minutes.
|type = client
|syntax = { "character": string, "time": int, "reason": string }
|sample = 
|prams = Time: an integer value of the timeout duration in minutes, being a minimum of one minute, and a maximum of 90 minutes.
|notes = This is an account-wide timeout from the chat, not a channel timeout for a character.
}}

{{Command
|cmd = TPN
|desc = "user x is typing/stopped typing/has entered text" for private messages.
|type = client
|syntax = { "character": string, "status": enum }
|sample = TPN {"character":"Leon Priest","status":"clear"}
|prams = status: can have a value of "clear", "paused", and "typing".
|notes = It is assumed a user is no longer typing after a private message has been sent, so there is no need to send a TPN of clear with it.
}}

{{Command
|cmd = UNB
|restriction = chatop
|desc = Unbans a character's account from the server.
|type = client
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = UPT
|desc = Requests info about how long the server has been running, and some stats about usage.
|type = client
|syntax = 
|sample = UPT
|prams = 
|notes = This command takes no parameters.
}}

{{Navbox/F-Chat}}
[[Category:Developer Resources]]
[[Category:F-Chat]]
