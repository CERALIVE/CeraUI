export function extractMessage<
	TMessage extends TBaseMessage,
	TType extends keyof TMessage,
	TBaseMessage = unknown,
>(message: TBaseMessage, type: TType): TMessage[TType] {
	return (message as TMessage)[type];
}
