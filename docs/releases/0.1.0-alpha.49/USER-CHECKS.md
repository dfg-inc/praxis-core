# Checks that need you (not done, not claimed)

Everything below was exercised by scripts, the MCP protocol, jsdom and one real headless-capable browser pane on local files. None of it was exercised in Claude Desktop or Claude Code with a model and a person. Automated tests are not manual Claude UI verification.

| # | Check | How |
| --- | --- | --- |
| 1 | Review page in your real flow | In Claude Code (CLI) or Desktop, ask the BA to run a requirements review. Open the link it gives you in your browser, change some marks, press Save, then ask "what is the status?". The decisions must appear without you pasting anything. |
| 2 | Save when the page cannot reach Praxis | Close the Claude session, open the saved copy under `.praxis/workflow/reviews/<work item>/requirements.html`, press Copy decisions, paste to the agent. In Claude Code CLI you must get an approval dialog listing exactly those decisions. Claude Desktop Code answers dialogs automatically, so it is not a human approval there: use the page Save in Desktop. |
| 3 | The skills are followed by the model | Start a fresh chat with a real request and watch: does it stop at each stage, give you links instead of JSON, refuse to accept things for you, write the plan before stories? The skills are text; the Runtime enforces the gates, but whether the model reads and follows the skills is a model behaviour no script proves. |
| 4 | Prototype against your real frontend | Run `praxis_frontend_discover` on one of your own applications and look at the prototype: are the colors, font and radius right, are the screens it lists the real ones? The heuristics (CSS custom properties, Tailwind/MUI theme objects) will miss other styling systems. |
| 5 | Continue in a new chat | Finish a session, open a new chat, say "continue this task". Check it names the right work item and the right next step, asks when there are several, and says that the old chat is not restored. |
| 6 | Several repositories on your real projects | Register your web, mobile and API repositories in one work item and read `praxis_repository_brief`. |
| 7 | Marketplace UI flow | Customize -> Plugins -> add the marketplace branch and install. Only the Claude Code CLI path was run. |
| 8 | In-place upgrade | Needs a version bump (a release step). Not done: nothing was released, tagged or merged. |
| 9 | Phone/tablet and other browsers | The pages are responsive and checked at phone width in one browser engine only. |
