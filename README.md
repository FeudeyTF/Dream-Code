<p align="center">
    <img src="https://raw.githubusercontent.com/AlecGhost/tree-sitter-vscode/refs/heads/master/icon.png"
        alt="tree-sitter-vscode logo"
        height="200">
</p>

# Dream Code

This extension adds syntax and semantic highlighting for the Dream Maker language in Visual Studio Code using **tree-sitter**.

# Quick Start

1. Install the Dream Code extension in VS Code.
2. Open any `.dm` file.
3. Wait for the first parser/queries download to complete.

# Configuration

The extension automatically downloads the **tree-sitter-dm** parser from the latest release in the https://github.com/FeudeyTF/tree-sitter-dm repository. It also downloads Tree-sitter query files for highlighting, injections, tags, and other features from the repository if they exist. You can specify the repository and query paths.


| Key                       | Description                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| tree-sitter-dm.dmParserRepository | The URL of the tree-sitter-dm repository. Default: https://github.com/FeudeyTF/tree-sitter-dm                        |
| tree-sitter-dm.dmQueriesPath      | The path to the repository query files. Default: queries/vscode                                                         |

Note that this extension uses WASM bindings for Tree-sitter parsers. Make sure they are generated with ABI version 15.

You can activate the debug mode with the setting:

```json
"tree-sitter-dm.debug": true
```

This will log information in the output channel `tree-sitter-dm`.

# Credits

This extension is based on the [tree-sitter-vscode](https://github.com/AlecGhost/tree-sitter-vscode) extension by [AlecGhost](https://github.com/AlecGhost).

# License

Dream Code syntax highlighter is free software. The project is licensed under GNU GPL v3.

