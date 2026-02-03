// @ts-expect-error import from untyped js
import { KEY } from "./keys.js";
// @ts-expect-error import from untyped js
import { USB } from "./usbhid.js";
// @ts-expect-error import from untyped js
import { runInitializers } from "./util.js";
// @ts-expect-error import from untyped js
import { kb, Vial } from "./vial/vial.js";

export const LANGUAGE_MAP: any = {};
export const QMK_KEYCODES: any = {};

export async function getKeymap() {
  runInitializers("load");
  const kbinfo: any = {};
  const opened: any = await USB.open([
    {
      // Filter for QMK/Vial kbs
      usagePage: 0xff60,
      usage: 0x61,
    },
    {
      // viable-qmk (Client ID protocol) HID interface
      usagePage: 0xff61,
      usage: 0x62,
    },
  ]);
  await Vial.getKeyboardInfo(kbinfo);
  await kb.getKeyMap(kbinfo);

  const l = kbinfo.keymap[0];
  const ret: any = {};
  LANGUAGE_MAP[KEY.localization] = {};

  for (let i = 0; i < l.length; i++) {
    const str = KEY.define(l[i]) ? KEY.define(l[i]).str : "";
    if (str.length === 1) {
      const chr = str.charCodeAt(0);
      if (chr >= 0x41 && chr <= 0x5a) {
        QMK_KEYCODES["Key" + str] = "Key" + i;
        ret["Key" + i] = [chr + 0x20, chr];
      } else if (chr) {
        ret["Key" + i] = [chr];
      }
    } else {
      ret["Key" + i] = [{ ligature: str }];
    }
  }
  return ret;
}
