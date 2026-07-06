import { ReactNode, useState } from "react";

/**
 * Tooltip hover nhẹ (không phụ thuộc thư viện ngoài).
 * Hiện bong bóng mô tả phía trên phần tử khi rê chuột / focus.
 */
export default function Tooltip({
  text,
  children,
  width = "16rem",
}: {
  text: string;
  children: ReactNode;
  width?: string;
}) {
  const [show, setShow] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      tabIndex={0}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          style={{ width }}
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 rounded-md border border-border bg-panel2 px-3 py-2 text-[11px] font-normal normal-case leading-snug text-gray-200 shadow-xl"
        >
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-panel2" />
        </span>
      )}
    </span>
  );
}
