import { useStdout } from "ink";
import { useEffect, useState } from "react";

/** Current terminal [columns, rows], updated on resize — used to size scroll viewports. */
export function useStdoutDimensions(): [number, number] {
  const { stdout } = useStdout();
  const [size, setSize] = useState<[number, number]>([stdout.columns ?? 80, stdout.rows ?? 24]);

  useEffect(() => {
    const onResize = (): void => setSize([stdout.columns ?? 80, stdout.rows ?? 24]);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
