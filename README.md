# FileInsight 🕵️‍♂️

**FileInsight** is a lightweight, intuitive Visual Studio Code extension that gives you instant context about how any file fits into your repository. 

Hover over any file in the customized FileInsight Explorer to see its exact role, what it exports, what it depends on, and general code health metrics—without ever needing to open the file.

### Features ✨

* **Instant Dependency Context**: See which files depend on a module and what a module imports.
* **Role Recognition**: Automatically classifies files into categories like `Entry Point`, `Core Module`, `Utility`, `Configuration`, `Test Suite`, etc.
* **Code Complexity & Metrics**: View Lines of Code (LOC), cyclomatic complexity estimation, and TODO counters.
* **Smart Explorer View**: Displays all non-binary files across your workspace while ignoring `node_modules` and standard build artifacts directly in your sidebar.

### Configuration ⚙️

You can configure the extension through your VS Code settings object:
* `fileInsight.enabled`: Enable/disable FileInsight (default: `true`).
* `fileInsight.maxFilesToScan`: Limit the maximum number of files to scan for the dependency graph (default: `1500`).

### Requirements 📋
* VS Code version ^1.85.0.

Enjoy exploring your codebase faster with FileInsight!
