// usbhid.js
//
////////////////////////////////////
//
//  Raw information and interaction with USBHID.
//
////////////////////////////////////
import { CLIENT_ID_CONSTANTS,clientIdWrapper } from "./client_id_wrapper.js";
import { unpack } from "./util.js";

// Playback: Handy for when I'm just tweaking UI stuff.
let SAVED = {};
const SETTINGS = {};

function loadPlayback() {
  /* eslint-disable-next-line no-undef */
  SAVED = getSaved("playback", {});
}

function playback(cmdargs) {
  const key = JSON.stringify(cmdargs);
  const ret = new Uint8Array(SAVED[key]);
  return ret.buffer;
}

function recordPlayback(cmdargs, ret) {
  const key = JSON.stringify(cmdargs);
  const val = [...new Uint8Array(ret)];
  SAVED[key] = val;
  /* eslint-disable-next-line no-undef */
  setSaved("playback", SAVED);
}

export const MSG_LEN = 32;

function endianFrom(num, bytes, little) {
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);

  switch (bytes) {
    case 2:
      dv.setInt16(0, num, little);
      break;
    case 4:
      dv.setInt32(0, num, little);
      break;
  }
  return Array.from(new Uint8Array(ab));
}

function convArrayEndian(ary, size) {
  if (size === 2) {
    return ary.map((num) => ((num >> 8) & 0xff) | ((num << 8) & 0xff00));
  } else {
    return ary.map(
      (num) =>
        ((num << 24) & 0xff000000) |
        ((num << 8) & 0xff0000) |
        ((num >> 8) & 0xff00) |
        ((num >> 24) & 0xff),
    );
  }
}

export function LE32(num) {
  return endianFrom(num, 4, true);
}

export function LE16(num) {
  return endianFrom(num, 2, true);
}

export function BE32(num) {
  return endianFrom(num, 4, false);
}

export function BE16(num) {
  return endianFrom(num, 2, false);
}

export const USB = {
  // This will be set to the opened device.
  device: undefined,

  // Enable Client ID protocol (default: true for viable-qmk support)
  useClientIdProtocol: true,

  open: async function (filters) {
    if (SETTINGS.playback) {
      loadPlayback();
      return true;
    } else {
      const devices = await navigator.hid.requestDevice({
        filters: filters,
      });

      if (devices.length === 0) {
        console.log("No device selected");
        return false;
      }

      if (devices.length !== 1) {
        console.log("Multiple devices selected, using first one");
      }

      USB.device = devices[0];

      if (!USB.device.opened) {
        await USB.device.open();
      }

      // Bootstrap Client ID protocol if enabled
      if (USB.useClientIdProtocol) {
        try {
          await clientIdWrapper.bootstrap(USB.device);
          console.log(
            "Client ID protocol enabled - ID: 0x" +
              clientIdWrapper.clientId.toString(16),
          );
        } catch (error) {
          console.warn(
            "Client ID bootstrap failed, falling back to legacy mode:",
            error.message,
          );
          USB.useClientIdProtocol = false;
        }
      }

      return true;
    }
  },

  formatResponse: (data, flags) => {
    if (!flags) flags = {};
    if (flags.unpack) {
      data = unpack(data, flags.unpack);
    } else {
      let cls = Uint8Array;
      let bytes = 1;
      // Which bytes?
      if (flags.int8) {
        cls = Int8Array;
      }
      if (flags.int16) {
        cls = Int16Array;
        bytes = 2;
      }
      if (flags.uint16) {
        cls = Uint16Array;
        bytes = 2;
      }
      if (flags.int32) {
        cls = Int32Array;
        bytes = 4;
      }
      if (flags.uint32) {
        cls = Uint32Array;
        bytes = 4;
      }
      // Wrapped Client ID responses are often 26 bytes. TypedArray constructors
      // require the buffer length to be a multiple of the element size.
      // Truncate any trailing partial element to avoid RangeError.
      if (data instanceof ArrayBuffer && bytes > 1) {
        const remainder = data.byteLength % bytes;
        if (remainder !== 0) {
          data = data.slice(0, data.byteLength - remainder);
        }
      }

      data = new cls(data);
      if (flags.bigendian) {
        data = convArrayEndian(data, bytes);
      }
    }

    if (flags.index !== undefined) {
      data = data[flags.index];
    } else if (flags.slice) {
      if (flags.slice.length) {
        data = data.slice(...flags.slice);
      } else {
        data = data.slice(flags.slice);
      }
    }
    if (flags.string) {
      data = new TextDecoder().decode(data);
    }
    if (flags.map) {
      data = data.map((d) => flags.map(d));
    }
    return data;
  },

  send: function (cmd, args, flags) {
    return this._send(cmd, args, flags, 0);
  },

  _send: (cmd, args, flags, retryCount) => {
    if (!USB.device) {
      return Promise.reject(
        new Error("USB device not opened. Call USB.open() first."),
      );
    }

    // Format what we're sending.
    let cmdargs = [cmd, ...(args || [])];

    // Determine protocol for wrapping
    let protocol = null;
    let wrappedPayload = null;
    if (USB.useClientIdProtocol && clientIdWrapper.isEnabled()) {
      // viable-qmk expects most host traffic to go through the Client ID wrapper.
      // Treat everything as VIA unless explicitly sending a Viable-protocol frame.
      if (cmd === CLIENT_ID_CONSTANTS.PROTOCOL_VIABLE) {
        protocol = CLIENT_ID_CONSTANTS.PROTOCOL_VIABLE;
        wrappedPayload = args || [];
      } else {
        protocol = CLIENT_ID_CONSTANTS.PROTOCOL_VIA;
        wrappedPayload = cmdargs;
      }
    }

    if (SETTINGS.playback) {
      const data = playback(cmdargs);
      const ret = USB.formatResponse(data, flags);
      return Promise.resolve(ret);
    }

    return new Promise((resolve, reject) => {
      const responseListener = (event) => {
        if (event.reportId !== 0) {
          return;
        }

        let responseData = event.data.buffer;

        if (protocol != null && clientIdWrapper.isEnabled()) {
          let unwrapped;
          try {
            unwrapped = clientIdWrapper.unwrapResponse(responseData);
          } catch (e) {
            clearTimeout(timeout);
            USB.device.removeEventListener("inputreport", responseListener);
            reject(e);
            return;
          }

          if (!unwrapped.valid) {
            if (unwrapped.errorType === "wrong_client") {
              return;
            }

            if (unwrapped.errorType === "expired") {
              clearTimeout(timeout);
              USB.device.removeEventListener("inputreport", responseListener);
              console.log("Client ID expired, re-bootstrapping...");
              clientIdWrapper
                .bootstrap(USB.device)
                .then(() => USB._send(cmd, args, flags, 0))
                .then(resolve)
                .catch(reject);
              return;
            }

            clearTimeout(timeout);
            USB.device.removeEventListener("inputreport", responseListener);
            reject(
              new Error(
                unwrapped.error || "Wrapped response validation failed",
              ),
            );
            return;
          }

          // Valid wrapped response: pass only the inner payload onwards.
          {
            const payloadBytes = new Uint8Array(unwrapped.payload);
            const alignedBuffer = new ArrayBuffer(payloadBytes.byteLength);
            new Uint8Array(alignedBuffer).set(payloadBytes);
            responseData = alignedBuffer;
          }
        }

        clearTimeout(timeout);
        USB.device.removeEventListener("inputreport", responseListener);
        const formattedResponse = USB.formatResponse(responseData, flags);
        resolve(formattedResponse);
      };

      USB.device.addEventListener("inputreport", responseListener);

      const timeout = setTimeout(() => {
        USB.device.removeEventListener("inputreport", responseListener);
        reject(new Error("HID response timeout"));
      }, 3000);

      const sendCommand = () => {
        let dataToSend;
        if (protocol != null) {
          if (clientIdWrapper.needsRenewal()) {
            console.log("Client ID near expiry, renewing...");
            return clientIdWrapper.bootstrap(USB.device).then(sendCommand);
          }
          dataToSend = clientIdWrapper.wrapCommand(
            protocol,
            wrappedPayload || [],
          );
        } else {
          dataToSend = new Uint8Array(MSG_LEN);
          dataToSend.set(cmdargs);
        }

        if (SETTINGS.record && !SETTINGS.playback) {
          recordPlayback(cmdargs, dataToSend);
        }

        USB.device.sendReport(0, dataToSend).catch((err) => {
          clearTimeout(timeout);
          USB.device.removeEventListener("inputreport", responseListener);
          reject(err);
        });
      };

      sendCommand();
    });
  },
};
