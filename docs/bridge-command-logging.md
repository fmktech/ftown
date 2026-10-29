# Bridge command logging

The bridge logs receipt of commands addressed to it. Routine `get_session_attention` reads are quiet by default; the bridge still processes them and returns the same success or failure responses. Commands explicitly addressed to another bridge are ignored without a receipt log. Existing response-publication errors remain logged.

To see attention-read receipts for this bridge, start or restart the bridge with `FTOWN_DEBUG_COMMANDS=1` in its environment. Only the exact value `1` enables these receipts; other values leave them quiet. Receipt logs contain the command type and request ID, not the command payload or attention content. This option does not alter other command logging.

In the currently inspected UI implementation, attention snapshots are requested on session subscription, command-channel subscription or reconnect, and prompt events. This is event-driven hydration, not a timer in that hook; the deployed UI version and any observed request rate may differ.
