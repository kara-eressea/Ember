<div style="float:right;margin:10px;">__TOC__</div>
==Commands sent by server==

{{Command
|cmd = ADL
|desc = Sends the client the current list of chatops.
|type = server
|syntax = { "ops": [string] }
|sample = ADL {"ops": ["Silver", "Hiro", "Jamii", "Oskenso", "Aniko", "King Mercy", "Hexxy", "Psy Chuan", "Playful Nips", "LegionRed", "Glitter", "Feath", "Viona", "Ambellina", "Becca Greene", "Victar"]}
|prams = 
|notes = 
}}

{{Command
|cmd = AOP
|desc = The given character has been promoted to chatop.
|type = server
|syntax = { "character": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = BRO
|desc = Incoming admin broadcast.
|type = server
|syntax = { "message": string }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = CDS
|desc = Alerts the client that that the channel's description has changed. This is sent whenever a client sends a JCH to the server.
|type = server
|syntax = { "channel": string, "description": string }
|sample = CDS {"description": "[color=red]No actual roleplay in here. For discussion of anything at all, please go to the correct channels.[/color] This is the channel for RP offers and announcements.", "channel": "Looking for RP"}
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CHA
|desc = Sends the client a list of all public channels.
|type = server
|syntax = { "channels": [object] }
|sample = CHA {"channels": [{"name":"Hermaphrodites","mode":"both","characters":144},{"name":"Avians","mode":"chat","characters":20},{"name":"World of Warcraft","mode":"both","characters":77},{"name":"Ageplay","mode":"both","characters":174} ... }
|prams = 
|notes = The channels object is a dictionary or associative array.
}}

{{Command
|cmd = CIU
|desc = Invites a user to a channel.
|type = server
|syntax = { "sender":string,"title":string,"name":string }
|sample = CIU {"sender":"Jinni Wicked","title":"Test Room","name":"ADH-c7fc4c15c858dd76d860"}
|prams = 
* sender: The character offering the invitation
* title: The display name for the channel.
* name: The channel ID/name.
|notes = In F-Chat 1.0, this renders as: "[user]" + sender + "[/user] has invited you to join [session=" + title + "]" + name + "[/session]."
}}

{{Command
|cmd = CBU
|desc = Removes a user from a channel, and prevents them from re-entering.
|restriction = chanop
|type = server
|syntax = {"operator":string,"channel":string,"character":string}
|sample = CBU {"operator":"Teal Deer","channel":"ADH-c7fc4c15c858dd76d860","character":"Pas un Caractere"}
|prams = operator: The chanop doing the banning.

channel: The channel from which the character is being banned.

character: The character being banned.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CKU
|desc = Kicks a user from a channel.
|restriction = chanop
|type = server
|syntax = {"operator":string,"channel":string,"character":string}
|sample = CKU {"operator":"Pas un Caractere","channel":"ADH-c7fc4c15c858dd76d860","character":"Teal Deer"}
|prams = operator: The chanop doing the kicking.

channel: The channel from which the character is being kicked.

character: The character being kicked.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = COA
|desc = Promotes a user to channel operator.
|restriction = chanop
|type = server
|syntax = {"character":"character_name", "channel":"channel_name"}
|sample = COA {"character":"Teal Deer", "channel":"ADH-c7fc4c15c858dd76d860"}
|prams = 
* channel: The channel the op is being added to.
* character: The character being made an op.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = COL
|desc = Gives a list of channel ops. Sent in response to JCH.
|type = server
|syntax = { "channel": string, "oplist": [string] }
|sample = COL { "oplist": ["","Robert Grayson","Natsudra"], "channel": "Frontpage"}
|prams = channel = The channel where these characters are ops. <br />
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS. The first name in the list will be the channel owner. Keep in mind that not all official channels have owners, so you may receive "" in the first position.
}}

{{Command
|cmd = CON
|desc = After connecting and identifying you will receive a CON command, giving the number of connected users to the network.
|type = server
|syntax = { "count": int }
|sample = CON {"count": 254}
|prams = 
|notes = 
}}

{{Command
|cmd = COR
|desc = Removes a channel operator.
|restriction = chanop
|type = server
|syntax = {"character":"character_name", "channel":"channel_name"}
|sample = COR {"character":"Teal Deer", "channel":"ADH-c7fc4c15c858dd76d860"}
|prams = 
* channel: The channel the op is being removed from.
* character: The character being demoted.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CSO
|desc = Sets the owner of the current channel to the character provided.
|type = server
|syntax = {"character":"string","channel":"string"}
|sample = CSO {"character":"Jinni Wicked","channel":"ADH-3875a3c8c11325b49992"}
|prams = 
* character: the character to set as owner
* channel: which channel to set the owner in
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = CTU
|desc = Temporarily bans a user from the channel for 1-90 minutes. A channel timeout.
|type = server
|syntax = {"operator":"string","channel":"string","length":int,"character":"string"}
|sample = CTU {"operator":"Michael Donohue","channel":"ADH-2e7542f374c7ec3a542d","length":10,"character":"TestingStuff"}
|prams = 
* operator: the moderator enacting the timeout
* channel: which channel to the user was timed out from.
* length: the number of minutes the character is timed out for
* character: which character has been timed out
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = DOP
|desc = The given character has been stripped of chatop status.
|type = server
|syntax = { "character": character }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = ERR
|desc = Indicates that the given error has occurred.
|type = error
|syntax = { "number": int, "message": string }
|sample = ERR {"message": "You have already joined this channel.", "number": 28}
|prams = 
|notes = 
}}

{{Command
|cmd = FKS
|desc = Sent by as a response to the client's FKS command, containing the results of the search.
|type = server
|syntax = { "characters": [object], "kinks": [object] }
|sample = FKS {"characters":["Some Guy", "Another Guy", "Some Gal"] "kinks": ["523","66"]}
|prams =
|notes = The numbers under kinks are the kinkids sent by the client. All search parameters can be retrieved [http://www.f-list.net/json/chat-search-getfields.json?ids=true here].
}}

{{Command
|cmd = FLN
|desc = Sent by the server to inform the client a given character went offline. 
|type = server
|syntax = { "character": string }
|sample = FLN {"character":"Hexxy"}
|prams = 
|notes = Should be treated as a global LCH for this character.
}}

{{Command
|cmd = HLO
|desc = Server hello command. Tells which server version is running and who wrote it.
|type = server
|syntax = { "message": string }
|sample = HLO {"message":"Welcome. Running F-Chat 0.8.6-Lua by Kira. Enjoy your stay."}
|prams = 
|notes = 
}}

{{Command
|cmd = ICH
|desc = Initial channel data. Received in response to JCH, along with CDS.
|type = server
|syntax = { "users": [object], "channel": string, "mode": enum }
|sample = ICH {"users": [{"identity": "Shadlor"}, {"identity": "Bunnie Patcher"}, {"identity": "DemonNeko"}, {"identity": "Desbreko"}, {"identity": "Robert Bell"}, {"identity": "Jayson"}, {"identity": "Valoriel Talonheart"}, {"identity": "Jordan Costa"}, {"identity": "Skip Weber"}, {"identity": "Niruka"}, {"identity": "Jake Brian Purplecat"}, {"identity": "Hexxy"}], "channel": "Frontpage", mode: "chat"}
|prams = 
|notes = "mode" can be "ads", "chat", or "both".
}}

{{Command
|cmd = IDN
|desc = Used to inform the client their identification is successful, and handily sends their character name along with it.
|type = server
|syntax = { "character": string }
|sample = 
|prams = 
|notes = If you send any commands before identifying, you will be disconnected.  
}}

{{Command
|cmd = JCH
|desc = Indicates the given user has joined the given channel. This may also be the client's character.
|type = server
|syntax = { "channel": string, "character": object, "title": string }
|sample = JCH {"character": {"identity": "Hexxy"}, "channel": "Frontpage", "title": "Frontpage"}
|prams = 
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = KID
|desc = Kinks data in response to a KIN client command.
|type = server
|syntax = { "type": enum, "message": string, "key": [int], "value": [int] }
|sample = 
|prams = Type: has three valid values; "start", "custom", and "end".
|notes = The message field is sent when the type is "start" or "end", as it will be displayed to the user. First, a KID command of type "start" is sent, then a series of KID commands of type "custom", holding "key" "value" properties of the character's custom kinks. Then, finally a KID command of type "end" is sent.
}}

{{Command
|cmd = LCH
|desc = An indicator that the given character has left the channel. This may also be the client's character.
|type = server
|syntax = { "channel": string, "character": character }
|sample = 
|prams = 
|notes = 
}}

{{Command
|cmd = LIS
|desc = Sends an array of all the online characters and their gender, status, and status message.
|type = server
|syntax = { characters: [object] }
|sample = LIS {"characters": [["Alexandrea", "Female", "online", ""], ["Fa Mulan", "Female", "busy", "Away, check out my new alt Aya Kinjou!"], ["Adorkable Lexi", "Female", "online", ""], ["Melfice Cyrum", "Male", "online", ""], ["Jenasys Stryphe", "Female", "online", ""], ["Cassie Hazel", "Herm", "looking", ""], ["Jun Watarase", "Male", "looking", "cute femmy boi looking for a dominate partner"],["Motley Ferret", "Male", "online", ""], ["Tashi", "Male", "online", ""], ["Viol", "Cunt-boy", "looking", ""], ["Dorjan Kazyanenko", "Male", "looking", ""], ["Asaki", "Female", "online", ""]]}
|prams = 
|notes = Because of the large amount of data, this command is often sent out in batches of several LIS commands. Since you got a CON before LIS, you'll know when it has sent them all.

The characters object has a syntax of ["Name", "Gender", "Status", "Status Message"].
}}

{{Command
|cmd = NLN
|desc = A user connected.
|type = server
|syntax = { "identity": string, "gender": enum, "status": enum }
|sample = NLN {"status": "online", "gender": "Male", "identity": "Hexxy"}
|prams = Identity: character name of the user connecting.<br />
Gender: a valid gender string.<br />
Status: a valid status, though since it is when signing on, the only possibility is online.
|notes = 
}}

{{Command
|cmd = IGN
|desc = Handles the ignore list.
|type = server
|syntax = { "action": string, "characters": [string] {{!}} "character":object }
|sample = IGN {"characters":["Teal Deer", "Pas un Caractere", "Testytest"],"action":"init"}<br />IGN {"character":"Teal Deer","action":"add"}<br />IGN {"character":"Teal Deer","action":"delete"}
|prams = action
* init: Sends the initial ignore list. Uses characters:[string] to send an array of character names.
* add: Acknowledges the addition of a character to the ignore list. Uses character:"string".
* delete: Acknowledges the deletion of a character from the ignore list. Uses character:"string".
* ''Presumably, 'list' and 'notify' also have server responses, but I have yet to get a client that will provide me those in the debug log.''
|notes = 
}}

{{Command
|cmd = FRL
|desc = Initial friends list.
|type = server
|syntax = { "characters": [string] }
|sample = 
|prams = 
|notes = FRL is a combination of all of this account's bookmarks and friends.
}}

{{Command
|cmd = ORS
|desc = Gives a list of open private rooms.
|type = server
|syntax = { "channels": [object] }
|sample = ORS { channels: [{"name":"ADH-300f8f419e0c4814c6a8","characters":0,"title":"Ariel's Fun Club"},{"name":"ADH-d2afa269718e5ff3fae7","characters":6,"title":"Monster Girl Dungeon RPG"},{"name":"ADH-75027f927bba58dee47b","characters":2,"title":"Naruto Descendants OOC"} ...] }
|prams = 
* name: The ID of the room. ADH- and twenty characters of hexadecimal.
* characters: The number of characters in the room.
* title: The user-friendly name of the room. This can contain all sorts of weird extended ASCII, so be prepared to handle that.
|notes = The channels object is an associative array/dictionary.
}}

{{Command
|cmd = PIN
|desc = Ping command from the server, requiring a response, to keep the connection alive.
|type = server
|syntax =
|sample = 
|prams = 
|notes = You have to respond to pings or you will be disconnected, as that will be detected as a timeout. The server will try to get a ping response three times, each time waiting 30 seconds. So if you don't respond, you will be disconnected after 90 seconds. Sending multiple pings within ten seconds will get you disconnected also.
}}

{{Command
|cmd = PRD
|desc = Profile data commands sent in response to a PRO client command.
|type = server
|syntax = { "type": enum, "message": string, "key": string, "value": string }
|sample = 
|prams = 
|notes = The message field is sent when the type is "start" or "end", as it will be displayed to the user. First, a PRD command of type "start" is sent, then a series of PRD commands of type "info" and "select", holding "key" "value" properties of the character's profile properties. Then, finally a PRD command of type "end" is sent.
}}

{{Command
|cmd = PRI
|desc = A private message is received from another user.
|type = server
|syntax = { "character": string, "message": string }
|sample = 
|prams = 
|notes = There is flood control; the same as the MSG command. At this time of writing, the maximum length of a private message is 50000 characters.
}}

{{Command
|cmd = MSG
|desc = A message is received from a user in a channel.
|type = server
|syntax = { "character": string, "message": string, "channel": string }
|sample = 
|prams = 
|notes = There is flood control and a max length. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.

}}


{{Command
|cmd = LRP
|desc = A roleplay ad is received from a user in a channel.
|type = server
|syntax = See MSG.
|sample = LRP { "channel": "Sex Driven LFRP", "message": "WHERE IS IT!?!? *uses magnifying glass*", "character": "Jay Rabbit"}
|prams = 
|notes = 
}}


{{Command
|cmd = RLL
|desc = Rolls dice or spins the bottle.
|type = server
|syntax = {"channel": string, "results": [int], "type": enum, "message": string, "rolls": [string], "character": string, "endresult": int} <br />OR <br /> >>RLL {"target":"string","channel":"string","message":"string","type":"bottle","character":"string"}
|sample = RLL {"channel":"ADH-dce8eb7af86213ac4c15","results":[22],"type":"dice","message":"[b]Teal Deer[/b] rolls 4d10: [b]22[/b]","rolls":["4d10"],"character":"Teal Deer","endresult":22} <br />
RLL {"target":"Teal Deer","channel":"ADH-c7fc4c15c858dd76d860","message":"[b]Michael Donohue[/b] spins the bottle: [b]Teal Deer[/b]","type":"bottle","character":"Michael Donohue"}
|prams = channel: What channel to display the result in.<br />
type: dice or bottle<br />
character: Who rolled the dice.<br />
message: The message the official clients will display in the channel.<br />
''If type:dice''
* results: Separate results for each set of dice.
* rolls: An array of dice sets and added numbers.
* endresult: The sum of all results.
''If type:bottle''
* target: who was selected.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = RMO
|desc = Change room mode to accept chat, ads, or both.
|type = server
|syntax = {"mode": enum, "channel": string}
|sample = RMO {"mode":"chat","channel":"ADH-c7fc4c15c858dd76d860"}
|prams = channel: Which channel is being changed.

mode:
* chat: Show only MSG.
* ads: Show only LRP.
* both: Show MSG and LRP.
|notes = As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = RTB
|desc = Real-time bridge. Indicates the user received a note or message, right at the very moment this is received.
|type = server
|syntax = { "type": string, "character": string }
|sample = 
|prams = 
|notes =
}}


{{Command
|cmd = SFC
|desc = Alerts admins and chatops (global moderators) of an issue.
|type = server
|syntax = {action:"string", moderator:"string", character:"string", timestamp:"string"}<br />
>> SFC {callid:int, action:"string", report:"string", timestamp:"string", character:"string", logid:int}
|sample = SFC {"action":"confirm", "moderator":"glitter", "character":"testingstuff", "timestamp":"string"}<br />
SFC {callid:int, action:"report", report:"Current Tab/Channel: Sex Driven LFRP {{!}} Reporting User: TestingStuff {{!}} :3 is not an RP ad.", timestamp:"", character="testingstuff","logid":18924}
|prams = 
* action: Either 'report' or 'confirm'. Report sends the report out to all globals/admins. Confirm claims the report and removes it from the list of unclaimed alerts.
* report (report): This includes the channel, the reported character name, and the text of the report.
* timestamp: The time the report was filed. Give me a few, I'm still trying to figure out the format.
* character: The character that filed the report. This should probably be turned into a user link or PM link, by the client.
* moderator (confirm): The moderator/admin who claimed the report
* callid: The alert number. This should be processed into the confirm link/button by the client, on report. 
* logid (report): The log number. Stick this at the end of a log link, to provide access to the log connected to this report: <nowiki>http://www.f-list.net/fchat/getLog.php?log=</nowiki><logid>
|notes = Also responds with SYS to the reporter: "SYS {message="The moderators have been alerted."}" This is not complete, and parts may be a little off. Let me know if you're getting parameters I haven't included or if I've mislabeled a string/int. I have no example for the timestamp parameter.
}}

{{Command
|cmd = STA
|desc = A user changed their status
|type = server
|syntax = { status: "status", character: "channel", statusmsg:"statusmsg" }
|sample = {"status":"looking","character":"Jippen Faddoul","statusmsg":"Just testing something"}
|prams = 
|notes = 
}}


{{Command
|cmd = SYS
|desc = An informative autogenerated message from the server. This is also the way the server responds to some commands, such as RST, CIU, CBL, COL, and CUB. The server will sometimes send this in concert with a response command, such as with SFC, COA, and COR.
|type = server
|syntax = { "message": string, "channel": string }
|sample = SYS { "message":"Testytest has been added to the moderator list for derp","channel": "ADH-011aeb5bb591b1f4721a"} <br /> 
SYS { "message":"Your invitation has been sent" } 
|prams = message: The message the server is sending <br />
channel: An optional argument if the message is related to a channel (such as a COL)
|notes = There currently is no command send in response to COL, CUB, CBL, and RST. Your client will have to parse SYS messages to look for these commands in order to implement them entirely. As with all commands that refer to a specific channel, official/public channels use the name, but unofficial/private/open private rooms use the channel ID, which can be gotten from ORS.
}}

{{Command
|cmd = TPN
|desc = A user informs you of his typing status.
|type = server
|syntax = { "character": string, "status": enum }
|sample = TPN {"character":"Leon Priest","status":"clear"}
|prams = status: can have a value of "clear", "paused", and "typing".
|notes = 
}}

{{Command
|cmd = UPT
|desc = Informs the client of the server's self-tracked online time, and a few other bits of information
|type = server
|syntax = { "time": int, "starttime": int, "startstring": string, "accepted": int, "channels": int, "users": int, "maxusers": int }
|sample = UPT { "time": 1359398530, "starttime": 1353393109, "startstring": "Tue, 20 Nov 2012 06:31:49 +0000", "accepted": 1665213, "channels": 694, "users": 2105, "maxusers": 2946 }
|prams = time: POSIX timestamp of the current time <br />
starttime: POSIX timestamp of when the server was last started <br />
startstring: Human-readable timestamp of when the server was last started <br />
accepted: How many connections have been accepted since last start <br />
channels: How many channels the server recognizes <br />
users : How many users are currently connected <br />
maxusers: The peak count of online users since last restart <br/>
|notes =
}}

{{Command
|cmd = VAR
|desc = Variables the server sends to inform the client about server variables.
|type = server
|syntax = { "variable": string, "value": int/float }
|sample = VAR {"value":4096,"variable":"chat_max"}<br>VAR {"value":50000,"variable":"priv_max"}<br>VAR {"value":50000,"variable":"lfrp_max"}<br>VAR {"value":600,"variable":"lfrp_flood"}<br>VAR {"value":0.5,"variable":"msg_flood"}<br>VAR {"value":["frontpage"],"variable":"icon_blacklist"}<br>VAR {"value":"35868","variable":"permissions"}
|prams = value: All parameters except for msg_flood should be treated as integers. 

variable:
* chat_max: Maximum number of bytes allowed with MSG.
* priv_max: Maximum number of bytes allowed with PRI.
* lfrp_max: Maximum number of bytes allowed with LRP.
* lfrp_flood: Required seconds between LRP messages.
* msg_flood: Required seconds between MSG messages.
* permissions: Permissions mask for this character.
* icon_blacklist: An array of channels that do not allow (e)icons.
|notes = Permissions mask is a little complicated.
<blockquote>
Admin: 1<br/>
chat-chatop: 2<br/>
chat-chanop: 4<br/>
helpdesk-chat: 8<br/>
helpdesk-general: 16<br/>
moderation-site: 32<br/>
reserved: 64<br/>
misc-grouprequests: 128<br/>
misc-newsposts: 256<br/>
misc-changelog: 512<br/>
misc-featurerequests: 1024<br/>
dev-bugreports: 2048<br/>
dev-tags: 4096<br/>
dev-kinks: 8192<br/>
developer: 16384<br/>
tester: 32768<br/>
subscriptions: 65536<br/>
former-staff: 131072<br/>
</blockquote>
}}


{{Navbox/F-Chat}}
[[Category:Developer Resources]]
[[Category:F-Chat]]
