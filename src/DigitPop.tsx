import { useEffect, useRef, useState } from "react";

/** transitions.dev number pop-in — replay when `value` changes. */
export function DigitPop({ value }: { value: string }) {
  const [anim, setAnim] = useState(true);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setAnim(false);
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnim(true));
    });
    return () => cancelAnimationFrame(id);
  }, [value]);

  return (
    <span className={"t-digit-group" + (anim ? " is-animating" : "")}>
      {value.split("").map((ch, i) => (
        <span
          key={`${value}-${i}`}
          className="t-digit"
          style={i > 0 ? { animationDelay: `${Math.min(i, 8) * 70}ms` } : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
