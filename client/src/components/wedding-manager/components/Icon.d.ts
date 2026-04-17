import React from 'react';

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

declare const Icon: React.FC<IconProps>;

export default Icon;
