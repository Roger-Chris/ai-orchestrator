# Privacy policy

AI Orchestrator is a personal assistant that one person runs on their own computers for their own use. It is not a hosted service: there are no user accounts, and its operator has no access to anyone else's data.

## What it reads from Google

With the owner's permission, it uses the Gmail API to:

- **Read mail** (`gmail.readonly`), to find tasks and to learn how the owner writes.
- **Send mail** (`gmail.send`), only if the owner gives this separate permission, and only when the owner taps Send on a draft they have seen.

## Where the data goes

- The sign-in and the tasks and drafts made from mail are stored on the owner's own computers.
- To find tasks or write a draft, the text of an email is sent to the AI service the owner has chosen to use, such as Anthropic Claude, OpenAI ChatGPT, Google Gemini or Groq. Those services handle it under their own terms.
- Data from Google is not sold, not used for advertising, and not shared with anyone else.

## Limited use

Use of data received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Removing access

The owner can end access at any time by running `orc gmail disconnect`, or at [Google Account permissions](https://myaccount.google.com/permissions). Locally stored data can be removed by deleting the app's `data/` folder.

## Contact

Open an issue at <https://github.com/Roger-Chris/ai-orchestrator/issues>.
