import rosDarkIcon from "../../assets/ROS-Dark-icon.png";
import rosLightIcon from "../../assets/ROS-Light-Icon.png";

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
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      role={alt === "" ? undefined : "img"}
      aria-label={alt === "" ? undefined : alt}
      aria-hidden={alt === "" ? true : undefined}
    >
      <img
        src={rosLightIcon}
        alt=""
        className="block h-full w-full object-contain dark:hidden"
      />
      <img
        src={rosDarkIcon}
        alt=""
        className="hidden h-full w-full object-contain dark:block"
      />
    </span>
  );
}
