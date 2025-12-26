import React from 'react';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

const Skeleton = ({ className, ...props }: SkeletonProps) => {
  return (
    <div
      className={`animate-pulse rounded-md bg-bg-surface/50 ${className}`}
      {...props}
    />
  );
};

export default Skeleton;
