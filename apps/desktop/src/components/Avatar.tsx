type AvatarProps = {
  initials: string;
  size?: number;
  active?: boolean;
  manager?: boolean;
  label?: string;
};

/** Avatar monocromático do Grafite: iniciais sobre a superfície; anel vermelho só quando há run ativo. */
export function Avatar({ initials, size = 36, active = false, manager = false, label }: AvatarProps) {
  const ring = active ? "border-brand" : "border-mist";
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={["inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold", manager ? "bg-brand text-white" : `border-[1.5px] bg-surface text-ink ${ring}`].join(" ")}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
    >
      {initials}
    </span>
  );
}
