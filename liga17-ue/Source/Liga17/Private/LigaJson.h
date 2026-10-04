#pragma once

#include "CoreMinimal.h"

#include <type_traits>

/**
 * FJsonObject::Values keys are FString in older engines and UE::FSharedString since 5.8,
 * which does not convert to FString implicitly. Turns either into an FString.
 */
template <typename KeyType>
FString LigaJsonKey(const KeyType& Key)
{
	if constexpr (std::is_convertible_v<const KeyType&, FString>)
	{
		return FString(Key);
	}
	else if constexpr (requires { FString(Key.ToView()); })
	{
		return FString(Key.ToView());
	}
	else if constexpr (requires { FString(*Key); })
	{
		return FString(*Key);
	}
	else
	{
		return FString(Key);
	}
}
