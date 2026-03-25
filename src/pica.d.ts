declare module 'pica' {
  type ResizeOptions = {
    alpha?: boolean;
    unsharpAmount?: number;
    unsharpRadius?: number;
    unsharpThreshold?: number;
  };

  type PicaInstance = {
    resize(
      from: HTMLCanvasElement,
      to: HTMLCanvasElement,
      options?: ResizeOptions,
    ): Promise<HTMLCanvasElement>;
  };

  export default function picaFactory(): PicaInstance;
}
