# Silly Memories Plus

[Русский](./README.md) | [English](./README.en.md)

A SillyTavern extension for hierarchical chat history summarization.

A model turns older messages into a summary of events and notes about relationships, items, promises, and other important details. This memory is sent alongside recent messages. The full conversation stays in your chat, and you can review and edit the memory blocks.

## Installation and first setup

1. Open Extensions in SillyTavern and click **Install extension**.
2. Enter the repository URL: `https://github.com/stellvt/silly-memories-plus`.
3. Reload the page after installation and open the Silly Memories Plus settings.
4. Under **Summarizer**, choose a connection profile. You can use a separate model for memory or keep **Current main API** to use your chat's main connection.
5. Click **Test summarizer** to check the connection with a short sample.
6. Open a chat. Automatic compaction is enabled by default; you can start with the default settings.

To run it manually, click **Summarize history** under **Runtime and maintenance**. Task progress appears above the submenus, next to **Stop task**.

## How memory works

By default, compaction starts at 75% of the available context window. The newest messages have a budget of 25% of the window and are sent in full. Older messages become a memory block with a target size of 4,000 tokens. The block's size depends on how much history it summarizes.

For example, an available context window of 80,000 tokens gives a compaction threshold of 60,000 tokens and a recent-history budget of about 20,000 tokens. You can adjust the threshold and recent-history share; they always add up to 100%.

A block's level tells you what it summarizes:

- **L1** summarizes original chat messages.
- **L2** combines several L1 blocks.
- **L3 and higher** further summarize combined blocks.

When memory takes up too much space, the extension merges eligible blocks. It can also merge them before reaching the threshold if the next request needs more room. The latest two messages are always kept in full.

The context meter above the submenus breaks usage down into memory, original history, pinned facts, and the rest of the prompt. It shows the compaction threshold and remaining space. The rest of the prompt is measured when a request is prepared; until then, the meter shows only the known usage.

## Working with blocks

### Viewing and editing

Open **Current chat memory**. **Active** contains blocks used to prepare the current context. **Archive** contains the source blocks of completed merges and blocks whose original messages have changed.

Click a block's header to expand it. **Edit** opens its fields in place: you can change the title, event summary, and every category of facts. In list fields, put each entry on a separate line, then click **Save block**.

### Regenerating with a preference

Select a block and click **Regenerate block**. You can add a preference, such as “Keep the reason for the argument and who received the key.” Click **Generate preview**, compare the new variant with the saved block, and choose **Save replacement** or **Discard preview**.

If the block is part of higher-level memory, regeneration also rebuilds the dependent merges.

### Merging blocks

Click the level badges on two or more adjacent active blocks of the same level, then click **Merge L1 → L2** or the corresponding action for that level.

You can merge the first two L1 blocks and leave a third one separate. The source blocks remain available in the archive. Select blocks in summary mode for merging.

### Choosing history and saving memory

**Use original history** sends the original messages covered by a block. **Use summary** sends its compact memory instead. Original messages use more context, and their size is reflected in the meter.

You can copy a selected block as JSON or export it as a separate file. **Export JSON** under **Runtime and maintenance** saves the chat's entire memory, including pinned facts.

**Delete** removes the selected block and its dependent merges; uncovered sections use their original messages. **Clear chat memory** clears all blocks and pinned facts after confirmation. Chat messages are retained.

## Pinned facts

Under **Pinned facts**, you manually enter details to send with every generation in this chat. For example: “Mira holds the silver key. Rowan promised to return before dawn.” Click **Save facts**.

These facts keep their wording through compaction and block regeneration. They count toward the context budget and apply even when automatic compaction is off. To remove them, empty the field and save it.

## Model and compaction settings

You can choose a separate Connection Manager profile for memory. Your main model continues answering through its own chat connection.

| Setting | What it controls |
| --- | --- |
| Compaction trigger | How full the context must be before compaction starts. Default: 75%. |
| Raw tail | The context share reserved for recent messages kept in full. Default: 25%. |
| Target block tokens | The desired size of a summary block. Default: 4,000 tokens. |
| Minimum source tokens | How much older history to accumulate before summarizing. Compaction can start with less when space is tight. |
| Summarizer input budget | The summarizer's available context window, covering the source, instructions, and response. |
| Maximum useful output tokens | The summarizer's content output allowance, separate from the target block size. |
| Injected memory role | Whether memory is sent as a system, user, or assistant message. |
| Inject structured ledger with narrative | Include relationship, item, and other detail notes alongside the event summary. |

The target sets the desired size; a complete summary can exceed it. The extension checks actual context usage before sending the chat request. In multi-stage compaction, each completed block is saved separately. If the next task fails, the next attempt starts from the saved memory.

If context is over budget, switch some blocks back to summary mode, shorten pinned facts, or increase the context window in SillyTavern.

The interface supports English and Russian. It follows SillyTavern's language by default. For a manual override, use **Runtime and maintenance → Interface language**.

## Custom prompts

Under **Summary prompts**, you can edit instructions for three tasks:

- **Raw chat → L1** creates memory from chat messages.
- **Memory blocks → rollup** combines existing summaries.
- **Oversized result → reduced block** shortens an overly long response.

Templates use `{{target_tokens}}` for the target size, `{{level}}` for the block level, and `{{schema}}` for the response format. Keep the format requirements so the extension can read the result.

An empty field uses the built-in prompt. **Restore default prompts** restores the standard instructions for all three tasks.
