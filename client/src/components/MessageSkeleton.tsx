import Skeleton from './Skeleton';

const MessageSkeleton = () => {
  return (
    <div className="flex gap-2 md:gap-4 justify-start w-full animate-in fade-in duration-500">
      <Skeleton className="w-8 h-8 rounded-full shrink-0" />
      <div className="flex flex-col gap-2 max-w-[85%] w-full">
        <Skeleton className="h-10 w-[200px] md:w-[300px] rounded-2xl" />
        <Skeleton className="h-20 w-full md:w-[500px] rounded-2xl" />
      </div>
    </div>
  );
};

export default MessageSkeleton;