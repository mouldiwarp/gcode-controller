// A byte pipe to a GRBL controller. SerialTransport talks to real USB hardware;
// FakeGrbl (sim/fakeGrbl.ts) implements the same interface in-process.
//
// Strings are treated as latin1 so realtime bytes above 0x7F (overrides, jog
// cancel) go over the wire as single bytes rather than UTF-8 sequences.

export interface Transport {
  readonly name: string;
  readonly simulated: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: (err?: Error) => void): void;
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  likelyGrbl: boolean;
}

// CH340 (FoxAlien and most hobby boards), FTDI, CP210x, Arduino, STM32 VCP (grblHAL).
const GRBL_VENDORS = new Set(['1a86', '0403', '10c4', '2341', '2a03', '0483', '16c0']);

type SerialPortModule = typeof import('serialport');

async function loadSerial(): Promise<SerialPortModule> {
  try {
    return await import('serialport');
  } catch (err) {
    throw new Error(`The serialport module is not available (${(err as Error).message}). Run npm install on this Mac.`);
  }
}

export async function listPorts(): Promise<PortInfo[]> {
  const { SerialPort } = await loadSerial();
  const ports = await SerialPort.list();
  return ports
    .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
    .map((p) => {
      const vendor = p.vendorId?.toLowerCase();
      return {
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: vendor,
        productId: p.productId?.toLowerCase(),
        likelyGrbl: (vendor !== undefined && GRBL_VENDORS.has(vendor)) || /usbserial|wchusbserial|usbmodem/i.test(p.path),
      };
    });
}

/** Pick the most likely GRBL port, preferring the /dev/cu.* callout device on macOS. */
export async function autoDetectPort(): Promise<string | undefined> {
  const ports = (await listPorts()).filter((p) => p.likelyGrbl);
  const cu = ports.find((p) => p.path.startsWith('/dev/cu.'));
  return (cu ?? ports[0])?.path;
}

export class SerialTransport implements Transport {
  readonly simulated = false;
  private port?: import('serialport').SerialPort;
  private dataCbs: ((chunk: string) => void)[] = [];
  private closeCbs: ((err?: Error) => void)[] = [];

  constructor(
    readonly name: string,
    private baudRate = 115200,
  ) {}

  async open(): Promise<void> {
    const { SerialPort } = await loadSerial();
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: this.name, baudRate: this.baudRate, autoOpen: false });
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        port.on('data', (buf: Buffer) => {
          const s = buf.toString('latin1');
          for (const cb of this.dataCbs) cb(s);
        });
        port.on('close', (e?: Error) => {
          for (const cb of this.closeCbs) cb(e ?? undefined);
        });
        port.on('error', (e: Error) => {
          for (const cb of this.closeCbs) cb(e);
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port || !port.isOpen) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  write(data: string): void {
    this.port?.write(Buffer.from(data, 'latin1'));
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCbs.push(cb);
  }
}
