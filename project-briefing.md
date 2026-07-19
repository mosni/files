This is the fresh project mosni/files, Hannah's File Drop.

First orient yourself in agent-docs. There is a recommended read order and instructions on how to bootstrap the docs.

Then run the first session where we establish technical baselines and a roadmap.

Project goals:

This project will be a file-sharing app.

Gist: Quick and easy one-click sharing of files that are too large to share through usual means (such as breaking messenger file size limits).
Focus shall be on the "quick and easy" part, the simplest path should be: open (tbd).mosni.dev, be immediately presented with a drop zone (if already logged-in), drop file, get link. Any additional option and feature MUST be optional and have sensible defaults, so that this path remains 3 actions and not more.

For UI library, see https://ui.mosni.dev/docs
For IdP see https://auth.mosni.dev/docs
For notification service and other server infrastructure see ../infrastructure on the local file system

Roles:
- files:write
- files:admin
- files:delete

Landing page:
- drop area (write perms only)
- admin panel (write perms only)
- IdP login button (if not logged in)
- files browser (browseable list of folders and files)
 -> includes all public files and folders
 -> includes all files and folders that were authored by user
 -> includes all files and folders for files:admin
 -> delete button for own files
 -> delete button on every file with files:delete role
 -> edit sharing options for own files (or all for admin)

Drop area:
- Upload through drag and drop
- optional: upload to folder (basic user folder by default)
- Click drop zone to add files through the native picker
- Upload from clipboard
- Upload from phone, using the native file picker options for both ios and android
- For mobile, be a PWA and register as a native share target
- Links generated and presented to copy: direct (straight to download) or preview (a wrapper page that previews videos, photos and text files, possibly using a code element for the latter)
- Multi-file: optionally upload multiple files and group them into a folder that gets a single sharing link. folders will always be a preview page that embeds the types that the preview link would embed but on one page. options to download the files individually, or all as archive.
- 3 protection levels
 -> "public": plain link, preserve file name, most basic. shows up in the main directory
 -> "semi-private": obfuscated link, possibly uuid or some other random string, does not show up in listings.
 -> "private": decide which accounts to share to
- Sensible progress bar on upload, no unobservable single post request if possible
- multiple progress bars for multi-upload


Admin panel:
- generate temp account invite link with access to a folder (see IdP docs on invite links)
 -> creates a folder that the invited account can freely upload to for a time period

Preview page:
- Video embed
- Photo albums that can include video embeds
- Save individual files
- Copy individual direct links
- Download archive of files
- Drop area to add more files to folder if owner or admin



To be done in first session:
1. Review the raw requirements. Poke holes, find inconsistencies, find things to clarify. Ask questions and grill me. We want a solid baseline to work off.
2. Organise raw requirements into Epics and maybe features (only if features aren't too specific before step 3)
3. decide on the tech stack. UI library and IdP are hard requirements, all other infrastructure tbd. Must run on one server, with docker as the baseline (see ../infrastructure). We will come up with the tech stack together. Present options and why they're good. I sign off on each (or argue with them).
4. Organise epics into Features/Stories, or a similar system with the tech stack in mind. (Tasks are generally left to the "planning sessions" in this system)
5. Final result: technical baseline documented, to-dos documented, roadmap written.
