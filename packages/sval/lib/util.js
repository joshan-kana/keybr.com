/* global nestedProxy */

// util.js
//
/////////////////////////////////////
//
// Utility functions
//
// Limited to DOM manipulation, QoL, Storage, Templates, etc.
//
// Ideally this should be transferrable between projects without a change.
//
/////////////////////////////////////

import { XzReadableStream } from "xzwasm";

let lzmaInstancePromise;

async function getLzmaInstance() {
  if (!lzmaInstancePromise) {
    lzmaInstancePromise = import("lzma-web").then(
      ({ default: LZMA }) => new LZMA(),
    );
  }
  return lzmaInstancePromise;
}

// QoL: This export function creates a constant container / enum that will throw an
// error if anything is requested that is undefined. For example: STATE.open vs
// STATE.okay - the latter will error instead of returning undefined.

// QoL: find(selector, parent=document) - wrapper around querySelector.
//      It ALSO lets parent match itself, unlike querySelector.
export function find(selector, par) {
  if (!par) {
    par = document;
  } else if (selector === "document") {
    return document;
  } else {
    if (par.matches && par.matches(selector)) return par;
  }
  return par.querySelector(selector);
}

// QoL: wrapper around find that throws an error if it finds nothing. In other
//      words, if this find fails, it's a bug.
export function get(selector, par) {
  const ret = find(selector, par);
  if (!ret) {
    console.log("get() Selector not found:", selector, par);
    throw 'Selector "' + selector + '" not found';
  }
  return ret;
}

// Find multiple.
export function findAll(selector, par) {
  if (!par) par = document;
  const ret = [...par.querySelectorAll(selector)];
  if (par.matches && par.matches(selector)) {
    ret.unshift(par);
  }
  return ret;
}

// Again, throw an error if they're not found.
export function getAll(selector, par) {
  const ret = findAll(selector, par);
  if (!ret || ret.length === 0) {
    console.log("getAll() Selector not found:", selector, par);
    throw 'Selector "' + selector + '" not found';
  }
  return ret;
}

// Storage: getSaved and setSaved: For local storage. Good for remembering UI
//          toggles and the like.
export function getSaved(name, otherwise) {
  try {
    const val = localStorage.getItem(name);
    if (val == null) {
      localStorage.setItem(name, JSON.stringify(otherwise));
      return otherwise;
    }
    return JSON.parse(val);
  } catch (err) {
    return otherwise;
  }
}

export function setSaved(name, val) {
  if (name === undefined) throw "Help";
  // TODO: this can throw
  localStorage.setItem(name, JSON.stringify(val));
  return val;
}

// DOM/QoL: Add attributes quickly.
export function addAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

// DOM: Make elements. EL('div', EL('span', "Text here"));
export function EL(name, attrs, ...children) {
  const ret = document.createElement(name);
  if (attrs) {
    if (attrs.style) {
      Object.assign(ret.style, attrs.style);
      delete attrs.style;
    }
    if (typeof attrs === "string" || "append" in attrs) {
      children.unshift(attrs);
    } else {
      addAttrs(ret, attrs);
    }
  }
  if (children && children.length > 0) {
    appendChildren(ret, children.flat());
  }
  return ret;
}

// DOM: Populate an element w/ children, but accepting more types of 'children'
export function appendChildren(el, ...children) {
  if (!children) return;
  let allChildren = [...children].flat();
  for (const child of allChildren) {
    if (typeof child === "string") {
      el.innerHTML += child;
    } else if (child) {
      el.appendChild(child);
    }
  }
  return el;
}

// DOM/QoL: cloneElement is a deep clone that also calls enableTriggers.
export function cloneElement(el) {
  const ret = el.cloneNode(true);
  return ret;
}

// DOM/QoL: Remove an element from its parent.
export function removeElement(el) {
  el.replaceWith("");
}

// DOM: traverse upwards the parent tree from an element until you get an element
//      matching a selector. If element matches it, it will be returned.
export function findParent(el, sel) {
  while (el && el.matches) {
    if (el.matches(sel)) return el;
    el = el.parentElement;
  }
  return undefined;
}

// Like find, but throws an error if not found.
export function getParent(el, sel) {
  const par = findParent(el, sel);
  if (par === undefined) {
    console.log('Cannot find parent sel "' + sel + '"', el);
    throw 'Invalid selector "' + sel + '"';
  }
  return par;
}

// QoL: is an object iterable? (for all the different collection types that we care about.)
export function isSafeIterable(obj) {
  if (obj === undefined || obj == null) {
    return false;
  }

  // Strings shouldn't be for us.
  if (["string"].includes(typeof obj)) {
    return false;
  }

  if (obj instanceof HTMLElement) return false;

  if (typeof obj === "object") return true;

  return typeof obj[Symbol.iterator] === "function";
}

const PROXY = {
  get(target, prop, receiver) {
    if (prop === Symbol.iterator) {
      return target[Symbol.iterator];
    }
    if (typeof prop === "symbol") {
      prop = prop.description;
    }
    if (prop === "toJSON") {
      return target;
    }
    if (!Object.prototype.hasOwnProperty.call(target, prop)) {
      console.log('target has no value "' + prop + '"', target);
      throw 'target has no value "' + prop + '"';
    }
    const val = target[prop];
    if (isSafeIterable(val)) {
      return nestedProxy(val);
    }
    return val;
  },
  set(target, prop, value) {
    if (typeof prop === "symbol") {
      target[prop.description] = value;
    } else {
      target[prop] = value;
    }
  },
  deleteProperty(target, prop) {
    delete target[prop];
  },
};

export function lockValue(val) {
  return new Proxy(val, PROXY);
}

// A wrapper around xzwasm's decompression.
export async function decompress(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // XZ magic header: FD 37 7A 58 5A 00
  const isXz =
    bytes.byteLength >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00;

  // LZMA "alone" header: properties byte (commonly 0x5d) + dict size + uncompressed size.
  // viable-qmk uses python's lzma.FORMAT_ALONE.
  const isLzmaAlone = bytes.byteLength >= 13 && bytes[0] === 0x5d;

  const wrapError = (kind, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const wrapped = new Error(`Definition decompress (${kind}) failed: ${msg}`);
    if (stack) wrapped.stack = `${wrapped.stack}\nCaused by:\n${stack}`;
    throw wrapped;
  };

  if (isXz) {
    try {
      const blob = new Blob([bytes]);
      const xrs = new XzReadableStream(blob.stream());
      const reader = xrs.getReader();

      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8").decode(out);
    } catch (err) {
      wrapError("xz", err);
    }
  }

  if (isLzmaAlone) {
    try {
      const lzma = await getLzmaInstance();

      // LZMA-JS / lzma-web expects a signed byte array.
      const input = Array.from(
        new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );

      const out = await lzma.decompress(input);
      if (typeof out === "string") {
        return out;
      }

      const outBytes = out instanceof Uint8Array ? out : new Uint8Array(out);
      return new TextDecoder("utf-8").decode(outBytes);
    } catch (err) {
      wrapError("lzma", err);
    }
  }

  throw new Error(
    "Unknown compressed definition format (expected XZ or LZMA-alone).",
  );
}

////////////////////////////////////
//
//  unpack - similar to most languages' unpack method.
//  Expects an ArrayBuffer(). unpack(arraybuffer, "<BHH")
//
//  <, >: little and big endian
//  b, B: 1 byte
//  h, H: 2 bytes
//  i, I: 4 bytes
//  q, Q: 8 bytes
//
////////////////////////////////////
export function unpack(buffer, str) {
  let offset = 0;
  const dv = new DataView(buffer);
  // endian-ness
  let le = true;
  const ret = [];
  for (const chr of str.split("")) {
    let val;
    switch (chr) {
      case "<":
        le = true;
        break;
      case ">":
        le = false;
        break;
      case "H":
        val = dv.getUint16(offset, le);
        offset += 2;
        break;
      case "h":
        val = dv.getInt16(offset, le);
        offset += 2;
        break;
      case "I":
        val = dv.getUint32(offset, le);
        offset += 4;
        break;
      case "i":
        val = dv.getInt32(offset, le);
        offset += 4;
        break;
      case "B":
        val = dv.getUint8(offset);
        offset++;
        break;
      case "b":
        val = dv.getInt8(offset);
        offset++;
        break;
      case "q":
        val = dv.getBigInt64(offset, le);
        offset += 8;
        break;
      case "Q":
        val = dv.getBigUint64(offset, le);
        offset += 8;
        break;
      default:
        console.log("Invalid char in unpack: " + chr);
    }
    if (val !== undefined) {
      ret.push(val);
    }
  }
  return ret;
}

export function range(num) {
  const ret = [];
  for (let i = 0; i < num; i++) {
    ret.push(i);
  }
  return ret;
}

////////////////////////////////////
//
//  Initializing javascript - in order.
//
// Add initializers to run on load, by file. 'order' is optional: If not given,
// order 100+n and things run low-high by order. If no order is ever given,
// they run first-last called. Or in other words, they order they show up in
// <script> tags.
//
////////////////////////////////////
const INITIALIZERS = {
  load: [],
  connected: [],
};

export function addInitializer(type, func, order) {
  if (order === undefined) order = 100 + INITIALIZERS[type].length;
  INITIALIZERS[type].push({ order: order, func: func });
}

export function runInitializers(type, ...args) {
  const sorted = INITIALIZERS[type].sort((a, b) => a.order - b.order);
  for (const call of sorted) call.func(...args);
}
