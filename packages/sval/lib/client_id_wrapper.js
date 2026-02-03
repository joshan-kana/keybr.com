// client_id_wrapper.js
//
////////////////////////////////////
//
// Client ID Protocol Wrapper for viable-qmk
//
// This module implements the Client ID protocol that allows multiple
// applications to access the keyboard's HID simultaneously without
// interference. Each client gets a unique ID that's echoed in responses.
//
////////////////////////////////////

const WRAPPER_PREFIX = 0xdd;
const PROTOCOL_VIA = 0xfe;
const PROTOCOL_VIABLE = 0xdf;
const PROTOCOL_ERROR = 0xff;

const ERROR_INVALID_CLIENT_ID = 0x01;
const ERROR_NO_IDS_AVAILABLE = 0x02;
const ERROR_UNKNOWN_PROTOCOL = 0x03;

/**
 * ClientIDWrapper handles client ID bootstrapping, command wrapping,
 * and response filtering for the viable-qmk protocol.
 */
export class ClientIDWrapper {
  constructor() {
    this.clientId = null;
    this.ttl = 120; // Default TTL in seconds
    this.lastBootstrap = 0;
    this.enabled = false; // Start disabled, enable after successful bootstrap
  }

  /**
   * Generate cryptographically secure random bytes for nonce
   */
  _generateNonce() {
    const nonce = new Uint8Array(20);
    crypto.getRandomValues(nonce);
    return nonce;
  }

  /**
   * Bootstrap to obtain a client ID from the keyboard
   * @param {Object} device - The HID device to send to
   * @returns {Promise<boolean>} True if bootstrap succeeded
   */
  async bootstrap(device) {
    const nonce = this._generateNonce();

    // Build bootstrap request: [0xDD] [0x00000000] [nonce:20]
    const request = new Uint8Array(32);
    request[0] = WRAPPER_PREFIX;
    // bytes 1-4 are client_id = 0x00000000 (already zero)
    request.set(nonce, 5);

    // Send request
    await device.sendReport(0, request);

    // Wait for response with timeout. We may receive unrelated input reports
    // (e.g. other app traffic) so we ignore anything that doesn't match.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", handler);
        reject(new Error("Bootstrap timeout"));
      }, 1000);

      const handler = (event) => {
        // We only use reportId 0 in this implementation.
        if (event.reportId !== 0) {
          return;
        }

        const response = new Uint8Array(event.data.buffer);

        // Must be wrapper prefix.
        if (response[0] !== WRAPPER_PREFIX) {
          return;
        }

        // Must have client_id field == 0x00000000 for bootstrap response.
        const dv0 = new DataView(response.buffer);
        const respClientId = dv0.getUint32(1, true);
        if (respClientId !== 0) {
          return;
        }

        // Verify nonce echo
        const responseNonce = response.slice(5, 25);
        for (let i = 0; i < 20; i++) {
          if (nonce[i] !== responseNonce[i]) {
            return;
          }
        }

        clearTimeout(timeout);
        device.removeEventListener("inputreport", handler);

        // Parse client ID (little-endian uint32)
        const dv = new DataView(response.buffer);
        this.clientId = dv.getUint32(25, true);

        // Check for error
        if (this.clientId === 0xffffffff) {
          const errorCode = response[29];
          reject(
            new Error(
              `Bootstrap failed with error code: 0x${errorCode.toString(16)}`,
            ),
          );
          return;
        }

        // Parse TTL (little-endian uint16)
        this.ttl = dv.getUint16(29, true);
        this.lastBootstrap = Date.now();
        this.enabled = true;

        resolve(true);
      };

      device.addEventListener("inputreport", handler);
    });
  }

  /**
   * Check if client ID needs renewal (at 70% of TTL)
   */
  needsRenewal() {
    if (!this.clientId || !this.enabled) return true;
    const elapsed = (Date.now() - this.lastBootstrap) / 1000;
    return elapsed > this.ttl * 0.7;
  }

  /**
   * Wrap a command with client ID protocol
   * @param {number} protocol - Protocol byte (0xFE for VIA, 0xDF for Viable)
   * @param {Array<number>} payload - The inner command payload
   * @returns {Uint8Array} Wrapped command ready to send
   */
  wrapCommand(protocol, payload) {
    if (!this.enabled || !this.clientId) {
      throw new Error("Client ID not initialized. Call bootstrap() first.");
    }

    // Wrapped command: [0xDD] [client_id:4] [protocol:1] [payload...]
    const wrapped = new Uint8Array(32);
    const dv = new DataView(wrapped.buffer);

    wrapped[0] = WRAPPER_PREFIX;
    dv.setUint32(1, this.clientId, true); // Little-endian
    wrapped[5] = protocol;

    // Copy payload (max 26 bytes after 6-byte wrapper header)
    const payloadLen = Math.min(payload.length, 26);
    for (let i = 0; i < payloadLen; i++) {
      wrapped[6 + i] = payload[i];
    }

    return wrapped;
  }

  /**
   * Unwrap a response and validate client ID
   * @param {ArrayBuffer} responseData - The raw response from the device
   * @returns {object} { valid: boolean, clientId?: number, protocol?: number, payload?: Uint8Array, errorType?: string, error?: string }
   */
  unwrapResponse(responseData) {
    const response = new Uint8Array(responseData);
    const dv = new DataView(response.buffer);

    if (response[0] !== WRAPPER_PREFIX) {
      return {
        valid: false,
        errorType: "not_wrapped",
        error: "Not a wrapped response",
      };
    }

    const clientId = dv.getUint32(1, true);
    const protocol = response[5];
    const payload = response.slice(6); // inner payload

    // Firmware can return protocol errors.
    if (protocol === PROTOCOL_ERROR) {
      const errorCode = payload[0];
      if (errorCode === ERROR_INVALID_CLIENT_ID) {
        return {
          valid: false,
          clientId,
          protocol,
          payload,
          errorType: "expired",
          error: "Invalid/expired client ID",
        };
      }
      return {
        valid: false,
        clientId,
        protocol,
        payload,
        errorType: "protocol_error",
        error: `Protocol error 0x${errorCode.toString(16)}`,
      };
    }

    if (clientId !== this.clientId) {
      return {
        valid: false,
        clientId,
        protocol,
        payload,
        errorType: "wrong_client",
        error: `Response for different client (got 0x${clientId.toString(16)}, expected 0x${this.clientId.toString(16)})`,
      };
    }

    return { valid: true, clientId, protocol, payload };
  }

  getClientId() {
    return this.clientId;
  }

  isEnabled() {
    return this.enabled;
  }

  getMaxPayloadSize() {
    // 32-byte report minus 6-byte wrapper header
    return 26;
  }
}

// Create singleton instance
export const clientIdWrapper = new ClientIDWrapper();

// Export constants for use in other modules
export const CLIENT_ID_CONSTANTS = {
  WRAPPER_PREFIX,
  PROTOCOL_VIA,
  PROTOCOL_VIABLE,
  PROTOCOL_ERROR,
  ERROR_INVALID_CLIENT_ID,
  ERROR_NO_IDS_AVAILABLE,
  ERROR_UNKNOWN_PROTOCOL,
};
