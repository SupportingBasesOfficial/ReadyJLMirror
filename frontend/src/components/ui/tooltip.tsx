import { type ReactNode, useState } from "react";

type TooltipPosition = "top" | "bottom";
type TooltipAlign = "center" | "left" | "right";

interface TooltipProps {
  text: string;
  children: ReactNode;
  position?: TooltipPosition;
  align?: TooltipAlign;
}

const alignStyle: Record<TooltipAlign, React.CSSProperties> = {
  center: { left: "50%", transform: "translateX(-50%)" },
  left:   { left: 0 },
  right:  { right: 0 },
};

export function Tooltip({ text, children, position = "top", align = "center" }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          className="absolute z-50 w-56 rounded px-2.5 py-1.5 text-[11px] leading-snug shadow-lg pointer-events-none"
          style={{
            background: "var(--surface-3, var(--surface-2))",
            color: "var(--text)",
            border: "1px solid var(--border)",
            ...(position === "top"
              ? { bottom: "calc(100% + 6px)" }
              : { top: "calc(100% + 6px)" }),
            ...alignStyle[align],
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

export function InfoIcon({
  text,
  position,
  align,
}: {
  text: string;
  position?: TooltipPosition;
  align?: TooltipAlign;
}) {
  return (
    <Tooltip text={text} position={position} align={align}>
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-bold cursor-default select-none ml-1"
        style={{
          background: "var(--border)",
          color: "var(--text-muted)",
          lineHeight: 1,
        }}
      >
        ?
      </span>
    </Tooltip>
  );
}
