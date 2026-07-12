Work in progress replacement documentation is available [https://toys.in.newtsin.space/api-docs/ at this page.]

==API Version 1==
To use most of the API endpoints, you need a ticket. The endpoints that do not require a ticket are: kink-list.php, info-list.php. 

All endpoints are POST requests.

The API(and site) is not intended for bulk data collection or export, and should not be used for such. Those found using the API in this manner will have their accounts suspended. Limit requests to one per second and character data requests to less than 200 per hour.

===Acquiring a ticket.===
POST to https://www.f-list.net/json/getApiTicket.php
Do NOT use GET for acquiring API tickets, this is being phased out.

Send two form fields, account and password.

If you do not require information about characters, friends or bookmarks, please pass one or more of the following fields with "true" as the value(without quotes):
no_characters, no_friends, no_bookmarks.

Tickets are valid for 30 minutes from issue, and invalidate all previous tickets for the account when issued.

===Sending a ticket.===
Any endpoint that requires a ticket must have the additional POST parameters of "account" which is the username of the account issued the ticket, and "ticket" which is the ticket acquired during the previous step.

===Bookmarks===
https://www.f-list.net/json/api/bookmark-add.php, Bookmark a profile. Takes one argument, "name".

https://www.f-list.net/json/api/bookmark-list.php, List all bookmarked profiles.

https://www.f-list.net/json/api/bookmark-remove.php, Remove a profile bookmark. Takes one argument, "name".

===Character data===
Note: If you try to use these on an account which is banned, timed out, blocked or deleted, you will receive an error.

https://www.f-list.net/json/api/character-data.php, Get a character's information. Requires one parameter, "name". Must be POST. Includes id, name, description, view count, infotags, kinks, custom kinks, subkinks, images, and inlines. You will need to assemble the data based on information from the mapping endpoint to obtain human readable names for infotags, kinks and list items.

https://www.f-list.net/json/api/character-list.php, Get a list of all the account's characters.

===Getting misc data===
https://www.f-list.net/json/api/group-list.php, Get the global list of all f-list groups.

https://www.f-list.net/json/api/ignore-list.php, Get a list of all profiles your account has on chat-ignore.

https://www.f-list.net/json/api/info-list.php, Get the global list of profile info fields, grouped. Dropdown options include a list of the options. Does not require the account and ticket form fields.

https://www.f-list.net/json/api/kink-list.php, Get the global list of kinks, grouped. Does not require the account and ticket form fields.

https://www.f-list.net/json/api/mapping-list.php Get the global list of kinks, infotags, infotag groups, and list items. Does not require the account and ticket form fields.

===Handling friend requests, friend list data===
https://www.f-list.net/json/api/friend-list.php, List all friends, account-wide, in a "your-character (dest) => the character's friend (source)" format.

https://www.f-list.net/json/api/friend-remove.php, Remove a profile from your friends. Takes two argument, "source_name" (your char) and "dest_name" (the character's friend you're removing).

https://www.f-list.net/json/api/request-accept.php, Accept an incoming friend request. Takes one argument, "request_id", which you can get with the request-list endpoint.

https://www.f-list.net/json/api/request-cancel.php, Cancel an outgoing friend request. Takes one argument, "request_id", which you can get with the request-pending endpoint.

https://www.f-list.net/json/api/request-deny.php, Deny a friend request. Takes one argument, "request_id", which you can get with the request-list endpoint.

https://www.f-list.net/json/api/request-list.php, Get all incoming friend requests.

https://www.f-list.net/json/api/request-pending.php, Get all outgoing friend requests.

https://www.f-list.net/json/api/request-send.php, Send a friend request. source_name, dest_name.


[[Category:F-Chat]]
[[Category:Developer Resources]]
