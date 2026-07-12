This page contains all the BBCode tags the wiki writers have been able to verify as working. This list also appears on the profile of [{{User|BBCode Reference}}. The '''F-Chat''' column indicates whether a tag works in F-Chat. The '''Quick-Click''' column indicates whether a tag has an insert button in text and comment fields that show BBCode buttons. (Not all text entry fields on F-list have a button block.) If there's something missing, please add it!

Examples are included for most of the tags, to make it easier to understand exactly what they do. Icon and Collapse do not have examples, because one doesn't have an image yet and the other would be unreasonably difficult, but the descriptions should be enough to get the basic idea across.

===Good to know:===
* Experimental 2.0 client may now preview your BBCode in message by using /preview command.
* Experimental 2.0 client also has BBCode [https://wiki.f-list.net/F-Chat_2.0#Keyboard_shortcuts keyboard shortcuts].
* Channel description is considered standard message. Only "F-Chat?" tags will work.
* When editing a profile, you can hit the 'preview BBCode' button to see what your profile will look like.  More importantly, this will show any BBCode errors at the top, which can help you figure out what's going on if something isn't working the way you expected.


__ToC__

{|  class="wikitable" cellspacing="0" cellpadding="2"
! colspan="5" | 
<h2 style="border-bottom:0em !important;">Text Formatting</h2>
|- 
! width="25%" align="middle" | BBCode
! width="15%" | Name
! width="5%" | F-Chat?
! width="5%" | Quick-Click?
! | Function
|-
| '''[b]'''text'''[/b]'''
| Bold
| Y
| Y
| Makes the text bolded, making it thicker and more pronounced.

Example <span style="font-weight:bold;">Example</span> Example
|-
| '''[i]'''text'''[/i]
| Italics
| Y
| Y
| Makes the text italicised, slanting each letter. (Does not have an effect during /me text)

Example <span style="font-style:italic;">Example</span> Example
|-
| '''[u]'''text'''[/u]
| Underline
| Y
| Y
| Underlines the text with a single thin line, can be used to highlight words plainly.

Example <span style="text-decoration:underline;">Example</span> Example
|-
| '''[s]'''text'''[/s]'''
| Strikethrough
| Y
| 
| Scores the selected text with a thin line across the middle, used to obscure or deprecate text without erasing it.

Example <span style="text-decoration:line-through;">Example</span> Example
|-
| '''[big]'''text'''[/big]'''
| Big
| 
| 
| Enlarged selected text by a few font sizes, cannot be enlarged more than once but can use common text formatting.

Example <span style="font-size: 1.4em;">Example</span> Example
|-
| '''[small]'''text'''[/small]'''
| Small
|  
|
| Reduces selected text by a couple of font sizes, cannot be shrunk more than once but can use common text formatting.

Example <span style="font-size: 0.8em;">Example</span> Example
|-
| '''[sup]'''text'''[/sup]'''
| Superscript
| Y
| 
| Reduces text size and aligns it higher on the written line, similar to [small] however it is top-aligned and works in F-Chat.

Example <sup style="vertical-align: top;">Example</sup> Example
|-
| '''[sub]'''text'''[/sub]'''
| Subscript
| Y
|
| Identical to [small], except this works in F-Chat. Unlike the HTML &lt;sub>, [sub] aligns to the text baseline, and not below it.

Example <sub style="vertical-align: baseline;">Example</sub> Example
|-
| '''[color=various]'''text'''[/color]'''
| Color
| Y
| Y
| Changes the selected text to the colour in writing from a set list, the valid colours are:<br>
"red, blue, white, yellow, pink, gray, green, orange, purple, black, brown, cyan"
Default theme: <div style="background:#1B446F;"><span style="color:white;">white</span>, <span style="color:black; text-shadow: 0px 1px 2px #777, 0px 0px 2px #9E9E9E;">black</span>, <span style="color:#f44;text-shadow:#000 0px 1px 2px;">red</span>, <span style="color:#1E90FF">blue</span>,<span style="color:yellow;text-shadow:#000 0px 1px 2px;">yellow</span>, <span style="color:#4f4;text-shadow:#000 0px 1px 2px;">green</span>, <span style="color:#FFCBDB;text-shadow:#000 0px 1px 2px;">pink</span>, <span style="color:#D3D3D3;text-shadow:#000 0px 1px 2px;">gray</span>, <span style="color:orange;text-shadow:#000 0px 1px 2px;">orange</span>, <span style="color:#E2AFFF;text-shadow:#000 0px 1px 2px;">purple</span>, <span style="color:#967117;text-shadow:#000 0px 1px 2px;">brown</span>, <span style="color:#00FFFF;text-shadow:#000 0px 1px 2px;">cyan</span></div>

Dark theme: <div style="background:#2E2828;"><span style="color:white;">white</span>, <span style="color: #888; text-shadow: 0px 1px 2px #000;">black</span>, <span style="color:#f44;text-shadow:#000 0px 1px 2px;">red</span>, <span style="color:#1E90FF">blue</span>,<span style="color:yellow;text-shadow:#000 0px 1px 2px;">yellow</span>, <span style="color:#4f4;text-shadow:#000 0px 1px 2px;">green</span>, <span style="color:#FFCBDB;text-shadow:#000 0px 1px 2px;">pink</span>, <span style="color:#D3D3D3;text-shadow:#000 0px 1px 2px;">gray</span>, <span style="color:orange;text-shadow:#000 0px 1px 2px;">orange</span>, <span style="color:#D0F;text-shadow:#000 0px 1px 2px;">purple</span>, <span style="color:#967117;text-shadow:#000 0px 1px 2px;">brown</span>, <span style="color:#00FFFF;text-shadow:#000 0px 1px 2px;">cyan</span></div>

Light theme: <div style="background:#FCFDFD;"><span style="color:white;">white</span>, <span style="color:black;">black</span>, <span style="color:#f44;text-shadow:#000 0px 1px 2px;">red</span>, <span style="color:#1E90FF">blue</span>, <span style="color:yellow;text-shadow:#000 0px 1px 2px;">yellow</span>, <span style="color:#4f4;text-shadow:#000 0px 1px 2px;">green</span>, <span style="color:#FFCBDB;text-shadow:#000 0px 1px 2px;">pink</span>, <span style="color:#D3D3D3;text-shadow:#000 0px 1px 2px;">gray</span>, <span style="color:orange;text-shadow:#000 0px 1px 2px;">orange</span>, <span style="color:#DD00FF;text-shadow:#000 0px 1px 2px;">purple</span>, <span style="color:#967117;text-shadow:#000 0px 1px 2px;">brown</span>, <span style="color:#00FFFF;text-shadow:#000 0px 1px 2px;">cyan</span></div>
|-
| '''<nowiki>[url=http://www.example.com]</nowiki>'''text'''[/url]'''<br/>'''[url]'''<nowiki>http://www.example.com</nowiki>'''[/url]'''
| Hyperlink
| Y
| Y
| In the first case, creates a link to the included URL that displays as the included text, with the F-List link icon. In the second case, creates a link that displays as the included URL, with the link icon. The <nowiki>'http://'</nowiki> part of the URL is REQUIRED or it will fail as a bad URL.
	
Example [[File:Chain.png]]<span class="plainlinks">[http://www.f-list.net Example]</span> Example<br />
Example [[File:Chain.png]]<span class="plainlinks">[http://www.f-list.net http://www.f-list.net]</span> Example
|-
|}


{| class="wikitable" cellspacing="0" cellpadding="2"
! colspan="5"| 
<h2 style="border-bottom:0em !important;">Layout Control</h2>
|- 
! width="25%" align="middle" | BBCode
! width="15%" | Name
! width="5%" | F-Chat?
! width="5%" | Quick-Click?
! | Function
|-
| '''[heading]'''text'''[/heading]'''
| Heading
| 
| 
| Heading has the combined effect of big, bold and line-spacing to make the text stand out. Text directly after the tag will automatically appear below the header. The colour is different than regular text, and will be the same colour as the links in the theme you are using.

Example
<div style="font-weight:bold;font-size:1.4em;margin:10px 0px;">Example</div>
Example
|-
| '''[indent]'''text'''[/indent]'''
| Indent
| 
| 
| Inserts approximately five characters worth of margin on the left side of the text. This does not only indent the first line of a paragraph, but indents the full body of the contained text, like a blockquote.
Example
<div style="padding-left:40px;">Lorem ipsum dolor sit amet, consectetur adipisicing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>
Example
|-
| '''[justify]'''text'''[/justify]'''
| Justify
|
| Y
| Justifies the alignment of the paragraphs contained within the tag, making each line, except the last, exactly the same length. Has little to no effect on text less than one line in length. This paragraph is justified.
|-
| '''[collapse=header]'''body'''[/collapse]'''
| Collapsible Topic
|
| Y
| Creates an F-List collapsible element which expands to the containing body text. You may name the collapsible element in the parameter tag 'header'<br>
TIP: Collapse is great for shrinking large paragraphs and optional topics down, but think whether you have enough content to fill one before over-doing it!
|-
| '''[quote]'''text'''[/quote]'''
| Quote
| 
| Y
| Creates a web-element that differs from the main background and fills the content with the selected text. A small 'Quote:' appears on the very top.

<div style="padding:10px; margin:2px; font-style:italic; border-style:solid; border-width:1px; -webkit-box-shadow:#111 0px 0px 1px; -moz-box-shadow:#111 0px 0px 1px; box-shadow:#111 0px 0px 1px;">'''Quote:'''<br />
Example Example Example</div>
|-
| '''[hr]'''
| Horizontal Rule
|
|
| Creates a horizontal rule, a divider normally generated at the bottom of each profile. Can be used to separate parts of the profile.

Example
<hr />
Example
|-
| '''[left]'''text'''[/left]'''
| Text align - Left
| 
| 
| Aligns the text to left side of the container. This is default align.

Example

TIP: If you want to have collapse header center/right aligned, you have to use:<br/>
''[center][collapse=header]body[/collapse][/center] or [right][collapse=header]body[/collapse][/right].''

The formating affects everything that's inside, so if you'd like only the header to be aligned, put a left tag in the body:<br/>
''[center][collapse=header][left]body[/left][/collapse][/center]''
|-
| '''[center]'''text'''[/center]'''
| Text align - Center
| 
| 
| Aligns the text to center of the container.

<div style="text-align: center; width: 100%;">Example</div>
|-
| '''[right]'''text'''[/right]'''
| Text align - Right
| 
| 
| Aligns the text to right side of the container.

<div style="text-align: right; width: 100%;">Example</div>

|}


{| class="wikitable" cellspacing="0" cellpadding="2"
! colspan="5" | 
<h2 style="border-bottom:0em !important;">Other</h2>
|- 
! width="25%" align="middle" | BBCode
! width="15%" | Name
! width="5%" | F-Chat?
! width="5%" | Quick-Click?
! | Function
|-
| '''[icon]'''name'''[/icon]'''
| Icon
| Y
| Y
| Displays the icon/avatar of the named user, and links it back to the user's profile. If the user has not uploaded an icon or the user does not exist, the default icon will be displayed. Can sometimes be used as emotes in F-Chat.
	
'''As of 2012.07.04, the [icon] tag does not work in LFRP, Frontpage, and possibly some other popular public channels. This was an intentional change. It still works in PMs and private/open private channels. Details are in [http://www.f-list.net/newspost/226/ this newspost].'''
|-
| '''[eicon]'''icon name'''[/eicon]'''
| Extended Icon
| Y
| Y
| Displays the extended icon -- icons from the icon gallery, rather than user avatars -- with the name provided. Eicons are global, meaning if you upload one to your icon gallery, anyone can use it. Intended to be used as emotes in F-Chat or profile decorations. Eicons may be animated gifs, but the animation can be disabled, in the settings for both webclients.
	
'''The [eicon] tag does not work in LFRP, Frontpage, and possibly some other popular public channels, as it is handled the same way as [icon], by the server. Details are in [http://www.f-list.net/newspost/226/ this newspost].'''
|-
| '''[user]'''name'''[/user]'''
| User Link
| Y
|
| Creates a link to the named user's profile, displaying as the user's name. On F-Chat 2.0 this comes with an extra bullet-point graphic before the link. On F-Chat 1.0, this bolds the username. On the rest of the site, there is no extra decoration.
	
Example [user]Example[/user] Example
|-
| '''[noparse]'''[tag]text[/tag]'''[/noparse]'''
| Noparse
| Y
| 
| Makes all other tags inside the [noparse] tag display as tags, instead of changing the text.

Example [color=yellow][b]Example[/b][/color] Example
|}

Finally, while it is not actually a BBCode command, note that you can link to a private channel from a profile on F-List by using the /code command to get your channel's code, then using the '''[url]''' tag, above, to create a hyperlink leading to http://www.f-list.net/fchat/?joinChannel=ADH-XXXXXXXXXXXXXXXXXXX -- with the last part, of course, replaced with the ADH code of your channel.


{{Navbox/Profile}}

[[Category:F-Chat]]
[[Category:Formatting]]
[[Category:Profile]]
