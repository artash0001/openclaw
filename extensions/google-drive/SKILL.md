# Google Drive

Use the `google_drive` tool to manage files in the user's Google Drive.

## Quick Reference

| User Intent | Action | Key Params |
|---|---|---|
| "Find files about X" | `search_files` | `query` |
| "List files in my Drive" | `list_files` | `folderId` (optional) |
| "Get info about a file" | `get_file` | `fileId` |
| "Read the contents of a doc" | `read_file` | `fileId` |
| "Upload this content" | `create_file` | `name`, `content` |
| "Create a new folder" | `create_folder` | `name` |
| "Update a file" | `update_file` | `fileId`, `content` or `name` |
| "Share a file with someone" | `share_file` | `fileId`, `email`, `role` |
| "Delete a file" | `delete_file` | `fileId` |

## Search Query Syntax

The `query` parameter in `search_files` uses Google Drive's query syntax:
- Search by name: `name contains 'budget'`
- Search by type: `mimeType = 'application/vnd.google-apps.spreadsheet'`
- Search in folder: `'FOLDER_ID' in parents`
- Full-text search: `fullText contains 'quarterly report'`
- Combine with `and`/`or`: `name contains 'report' and mimeType = 'application/pdf'`

## Common MIME Types

| Type | MIME |
|---|---|
| Google Doc | `application/vnd.google-apps.document` |
| Google Sheet | `application/vnd.google-apps.spreadsheet` |
| Google Slides | `application/vnd.google-apps.presentation` |
| Folder | `application/vnd.google-apps.folder` |
| PDF | `application/pdf` |

## Workflow Tips

1. **Before uploading**: Use `search_files` or `list_files` to check if the file already exists.
2. **Reading Google Docs**: Use `read_file` — it automatically exports Google Docs as plain text, Sheets as CSV.
3. **Creating in a folder**: Pass `parentId` to `create_file` or `create_folder`.
4. **Sharing**: Use `share_file` with role `reader`, `commenter`, or `writer`.
5. **Deleting**: `delete_file` moves to trash (recoverable). It does not permanently delete.

## Auth Errors

If you receive a 401 or "token expired" error, inform the user they need to re-authenticate:
> Your Google Drive session has expired. Please run the provider setup again to re-authenticate.

If you receive a 403 error, the user may need to enable the Drive API in their Google Cloud project.
