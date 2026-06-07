import aiIcon from "./assets/ai.png";

type RosieIconProps = {
  className?: string;
  size?: number;
  alt?: string;
};

export default function RosieIcon({
  className = "",
  size = 18,
  alt = "ROSIE",
}: RosieIconProps) {
  return (
    <img
      src={aiIcon}
      alt={alt}
      width={size}
      height={size}
      className={`inline-block shrink-0 object-contain ${className}`}
    />
  );
}
