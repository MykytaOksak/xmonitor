// App mark: "0x" followed by a block cursor, matching the exported icon set in
// public/ (geometry measured off xarb-cursor-white-512.png, normalised to a
// 64-unit box). Monochrome by design — the export carries no green accent.
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ display: 'block', flex: 'none' }}
    >
      <text
        x="7.2"
        y="39.6"
        fontSize="25.8"
        letterSpacing="1.46"
        fontFamily="'IBM Plex Mono', monospace"
        fontWeight={600}
        fill="#EAEAEA"
      >
        0x
      </text>
      <rect x="46" y="18" width="9.9" height="27.9" fill="#EAEAEA" />
    </svg>
  );
}
