# PureRef Connector

This Node.js application acts as a bridge between the native PureRef desktop application and the Svelte frontend.

## Purpose

Its main functions are:
1.  **Watch for Changes:** It monitors a specified PureRef `.pur` scene file for any modifications.
2.  **Export Scene:** When the `.pur` file changes, it uses the PureRef command-line interface (CLI) to export the current scene as a PNG image.
3.  **Serve Image:** It hosts a simple HTTP server to serve the latest exported PNG image.
4.  **Notify Frontend:** It runs a WebSocket server to notify the connected Svelte frontend whenever a new image has been exported, prompting the frontend to refresh its display.

## Configuration

Before running, you **must** edit `index.js` and configure the following variables at the top of the file:

*   `PUREF_EXECUTABLE_PATH`: Set this to the full path of your `PureRef.exe` installation.
*   `PUREF_SCENE_PATH`: Set this to the full path of the `.pur` file you wish to monitor and display.

## How to Run

1.  **Configure `index.js`** as described above.
2.  **Start the Connector:**
    *   **Windows:** Double-click the `start-connector.bat` file located in this directory.
    *   **Other OS (or manual):** Open a terminal in this directory and run `node index.js`.

Once running, the connector will listen for changes to your PureRef scene and make the exported image available to the frontend.
