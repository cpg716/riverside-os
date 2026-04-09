import React from 'react';

const Skeleton = ({ className, ...props }) => {
    return (
        <div
            className={`animate-pulse bg-app-border/50 rounded ${className}`}
            {...props}
        />
    );
};

export default Skeleton;
