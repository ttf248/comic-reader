interface Props {
  /** 开关的无障碍名称。调用方负责渲染可见的文字标签。 */
  label: string;
  checked: boolean;
  /** 保存进行中置灰；纯本地的开关可以省略。 */
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/**
 * 药丸开关。
 *
 * 视觉是 20px 的药丸（和系统设置一致），可点区域撑到 28px：
 * 外层按钮 28px 高、内部药丸居中，命中区从 20px 提到 28px，
 * 视觉尺寸完全不变。20px 的开关在触摸设备上很难点准。
 */
export default function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-7 w-9 items-center justify-center rounded-full disabled:opacity-50"
    >
      <span
        className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-bg-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-bg-elevated rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
    </button>
  );
}
