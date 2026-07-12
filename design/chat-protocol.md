==General Information==

===Introduction===

====About F-Chat====

The F-Chat network is the first network of it's kind; a completely open online roleplaying chat network, that offers the freedom and support for third parties to implement their own client, as long as they properly follow the spec. F-Chat was developed as part of F-List.net, a large text-based roleplaying website, and community, by the request of it's users, who were asking for a way to roleplay in realtime, rather than post-by-post.

====About this documentation====

We aim to offer clear documentation to allow people to connect to F-Chat with third party clients. After all, the more people on our network, the more fun roleplaying will be! If you follow our guidelines and client implementation rules, we'll be happy to advertise your third party client and website as well.

===Websockets===

Connections are expected to follow WebSocket protocols, this means sending a valid Hybi WebSocket request header before sending commands.

All commands must be properly encapsulated in a valid Hybi WebSocket frame. Invalid WebSocket frames will result in a disconnect.

===Connecting===

The F-Chat server runs on wss://chat.f-list.net/chat2. After connecting you cannot send commands, until you have properly identified, or you will be disconnected. A testserver for experimentation is available on request; please file a helpdesk ticket to request access.
Please use the test server for anything you are unsure of, testing on the live server is heavily discouraged.

===Disconnecting===

Simply closing the socket is acceptable. Server does not follow the websocket guidelines on closing sockets using the closing frame.

===Command Format===

All commands look like this:

<big><pre>XXX {"property":"value","anotherproperty":"value"}</pre></big>

Commands contain a three character message type. These currently are always capitalized, and are case-sensitive. This is followed by a space, and a json payload. All commands must be in valid UTF-8.
Commands without a json payload should not contain a trailing space after the message type.
The minimum size of a command is three characters. Commands under this size will result in a disconnect.

===Error Codes===

[[FChat error codes]]

==Guidelines==
: ''moved to [[Developer Policy]]''

==Commands sent by the client==

[[FChat client commands]]

==Commands sent by the server==

[[FChat server commands]]


{{Navbox/F-Chat}}

[[Category:F-Chat]]
[[Category:Developer Resources]]
