import type { Sideband } from "@/audio/player";

/** A demodulator's passband, as offsets from the tuned frequency (Hz). */
export interface Passband { lowHz: number; highHz: number }

/** FM: the 12.5 kHz channel filter's flat part (engine ChannelSpec::CHANNEL_12_5). */
export const FM_PASSBAND: Passband = { lowHz: -5_625, highHz: 5_625 };
/** SSB: SsbBand::WIDE, 50 Hz to 2.95 kHz from the dial, above it for USB and below for LSB. */
export const USB_PASSBAND: Passband = { lowHz: 50, highHz: 2_950 };
export const LSB_PASSBAND: Passband = { lowHz: -2_950, highHz: -50 };

export function passbandFor(ssb: Sideband | null): Passband {
  return ssb === "usb" ? USB_PASSBAND : ssb === "lsb" ? LSB_PASSBAND : FM_PASSBAND;
}
