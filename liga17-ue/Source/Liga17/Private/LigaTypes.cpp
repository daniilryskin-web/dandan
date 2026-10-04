#include "LigaTypes.h"

namespace
{
	const TCHAR* GTypeIds[] = {
		TEXT("normal"), TEXT("fire"), TEXT("water"), TEXT("electric"), TEXT("grass"), TEXT("ice"),
		TEXT("fighting"), TEXT("poison"), TEXT("ground"), TEXT("flying"), TEXT("psychic"), TEXT("bug"),
		TEXT("rock"), TEXT("ghost"), TEXT("dragon"), TEXT("dark"), TEXT("steel"), TEXT("fairy"),
	};
	const TCHAR* GTypeNames[] = {
		TEXT("Нормальный"), TEXT("Огненный"), TEXT("Водный"), TEXT("Электрический"), TEXT("Травяной"), TEXT("Ледяной"),
		TEXT("Боевой"), TEXT("Ядовитый"), TEXT("Земляной"), TEXT("Летающий"), TEXT("Психический"), TEXT("Насекомое"),
		TEXT("Каменный"), TEXT("Призрак"), TEXT("Дракон"), TEXT("Тёмный"), TEXT("Стальной"), TEXT("Волшебный"),
	};
	const TCHAR* GTypeColors[] = {
		TEXT("A8A77A"), TEXT("EE8130"), TEXT("6390F0"), TEXT("F7D02C"), TEXT("7AC74C"), TEXT("96D9D6"),
		TEXT("C22E28"), TEXT("A33EA1"), TEXT("E2BF65"), TEXT("A98FF3"), TEXT("F95587"), TEXT("A6B91A"),
		TEXT("B6A136"), TEXT("735797"), TEXT("6F35FC"), TEXT("705746"), TEXT("B7B7CE"), TEXT("D685AD"),
	};

	using T = EPokeType;
	struct FRow { TArray<T> X2, Half, Zero; };

	const TArray<FRow>& Chart()
	{
		static TArray<FRow> Rows;
		if (Rows.Num() == 0)
		{
			Rows.SetNum((int32)T::Count);
			auto Set = [](FRow& R, TArray<T> X2, TArray<T> Half, TArray<T> Zero) { R.X2 = X2; R.Half = Half; R.Zero = Zero; };
			Set(Rows[(int32)T::Normal], {}, {T::Rock, T::Steel}, {T::Ghost});
			Set(Rows[(int32)T::Fire], {T::Grass, T::Ice, T::Bug, T::Steel}, {T::Fire, T::Water, T::Rock, T::Dragon}, {});
			Set(Rows[(int32)T::Water], {T::Fire, T::Ground, T::Rock}, {T::Water, T::Grass, T::Dragon}, {});
			Set(Rows[(int32)T::Electric], {T::Water, T::Flying}, {T::Electric, T::Grass, T::Dragon}, {T::Ground});
			Set(Rows[(int32)T::Grass], {T::Water, T::Ground, T::Rock}, {T::Fire, T::Grass, T::Poison, T::Flying, T::Bug, T::Dragon, T::Steel}, {});
			Set(Rows[(int32)T::Ice], {T::Grass, T::Ground, T::Flying, T::Dragon}, {T::Fire, T::Water, T::Ice, T::Steel}, {});
			Set(Rows[(int32)T::Fighting], {T::Normal, T::Ice, T::Rock, T::Dark, T::Steel}, {T::Poison, T::Flying, T::Psychic, T::Bug, T::Fairy}, {T::Ghost});
			Set(Rows[(int32)T::Poison], {T::Grass, T::Fairy}, {T::Poison, T::Ground, T::Rock, T::Ghost}, {T::Steel});
			Set(Rows[(int32)T::Ground], {T::Fire, T::Electric, T::Poison, T::Rock, T::Steel}, {T::Grass, T::Bug}, {T::Flying});
			Set(Rows[(int32)T::Flying], {T::Grass, T::Fighting, T::Bug}, {T::Electric, T::Rock, T::Steel}, {});
			Set(Rows[(int32)T::Psychic], {T::Fighting, T::Poison}, {T::Psychic, T::Steel}, {T::Dark});
			Set(Rows[(int32)T::Bug], {T::Grass, T::Psychic, T::Dark}, {T::Fire, T::Fighting, T::Poison, T::Flying, T::Ghost, T::Steel, T::Fairy}, {});
			Set(Rows[(int32)T::Rock], {T::Fire, T::Ice, T::Flying, T::Bug}, {T::Fighting, T::Ground, T::Steel}, {});
			Set(Rows[(int32)T::Ghost], {T::Psychic, T::Ghost}, {T::Dark}, {T::Normal});
			Set(Rows[(int32)T::Dragon], {T::Dragon}, {T::Steel}, {T::Fairy});
			Set(Rows[(int32)T::Dark], {T::Psychic, T::Ghost}, {T::Fighting, T::Dark, T::Fairy}, {});
			Set(Rows[(int32)T::Steel], {T::Ice, T::Rock, T::Fairy}, {T::Fire, T::Water, T::Electric, T::Steel}, {});
			Set(Rows[(int32)T::Fairy], {T::Fighting, T::Dragon, T::Dark}, {T::Fire, T::Poison, T::Steel}, {});
		}
		return Rows;
	}
}

namespace LigaTypes
{
	EPokeType Parse(const FString& Id)
	{
		for (int32 i = 0; i < (int32)EPokeType::Count; ++i)
		{
			if (Id.Equals(GTypeIds[i], ESearchCase::IgnoreCase)) return (EPokeType)i;
		}
		return EPokeType::Normal;
	}

	FString Name(EPokeType T) { return GTypeNames[FMath::Clamp((int32)T, 0, (int32)EPokeType::Count - 1)]; }

	FLinearColor Color(EPokeType T)
	{
		return FLinearColor(FColor::FromHex(GTypeColors[FMath::Clamp((int32)T, 0, (int32)EPokeType::Count - 1)]));
	}

	float Multiplier(EPokeType Attack, EPokeType Defend)
	{
		const FRow& R = Chart()[(int32)Attack];
		if (R.Zero.Contains(Defend)) return 0.f;
		if (R.X2.Contains(Defend)) return 2.f;
		if (R.Half.Contains(Defend)) return 0.5f;
		return 1.f;
	}

	float Effectiveness(EPokeType Attack, const TArray<EPokeType>& Defenders)
	{
		float M = 1.f;
		for (EPokeType D : Defenders) M *= Multiplier(Attack, D);
		return M;
	}

	FString EffectivenessLabel(float Mult)
	{
		if (Mult == 0.f) return TEXT("Не действует");
		if (Mult >= 4.f) return TEXT("Сокрушительно ×4");
		if (Mult >= 2.f) return TEXT("Эффективно ×2");
		if (Mult <= 0.25f) return TEXT("Почти без эффекта ×¼");
		if (Mult < 1.f) return TEXT("Слабо ×½");
		return FString();
	}

	EStatus ParseStatus(const FString& Id)
	{
		if (Id == TEXT("brn")) return EStatus::Burn;
		if (Id == TEXT("psn")) return EStatus::Poison;
		if (Id == TEXT("par")) return EStatus::Paralysis;
		if (Id == TEXT("slp")) return EStatus::Sleep;
		if (Id == TEXT("frz")) return EStatus::Freeze;
		return EStatus::None;
	}

	FString StatusName(EStatus S)
	{
		switch (S)
		{
		case EStatus::Burn: return TEXT("Ожог");
		case EStatus::Poison: return TEXT("Отравление");
		case EStatus::Paralysis: return TEXT("Паралич");
		case EStatus::Sleep: return TEXT("Сон");
		case EStatus::Freeze: return TEXT("Заморозка");
		default: return FString();
		}
	}

	FString StatusShort(EStatus S)
	{
		switch (S)
		{
		case EStatus::Burn: return TEXT("ОЖГ");
		case EStatus::Poison: return TEXT("ЯД");
		case EStatus::Paralysis: return TEXT("ПАР");
		case EStatus::Sleep: return TEXT("СОН");
		case EStatus::Freeze: return TEXT("ЛЁД");
		default: return FString();
		}
	}

	FLinearColor StatusColor(EStatus S)
	{
		switch (S)
		{
		case EStatus::Burn: return FLinearColor(FColor::FromHex(TEXT("EE8130")));
		case EStatus::Poison: return FLinearColor(FColor::FromHex(TEXT("A33EA1")));
		case EStatus::Paralysis: return FLinearColor(FColor::FromHex(TEXT("D4B000")));
		case EStatus::Sleep: return FLinearColor(FColor::FromHex(TEXT("7F8C9A")));
		case EStatus::Freeze: return FLinearColor(FColor::FromHex(TEXT("5FC6D6")));
		default: return FLinearColor::Transparent;
		}
	}

	int32 ParseBattleStat(const FString& Id)
	{
		if (Id == TEXT("atk")) return BS_Atk;
		if (Id == TEXT("def")) return BS_Def;
		if (Id == TEXT("spa")) return BS_SpA;
		if (Id == TEXT("spd")) return BS_SpD;
		if (Id == TEXT("spe")) return BS_Spe;
		if (Id == TEXT("acc")) return BS_Acc;
		if (Id == TEXT("eva")) return BS_Eva;
		return -1;
	}

	FString BattleStatName(int32 Stat)
	{
		static const TCHAR* Names[] = {
			TEXT("атака"), TEXT("защита"), TEXT("спец. атака"), TEXT("спец. защита"), TEXT("скорость"), TEXT("точность"), TEXT("уклонение"),
		};
		return (Stat >= 0 && Stat < BS_Count) ? Names[Stat] : TEXT("?");
	}

	FString StatName(int32 Stat)
	{
		static const TCHAR* Names[] = { TEXT("HP"), TEXT("Атака"), TEXT("Защита"), TEXT("Сп. атака"), TEXT("Сп. защита"), TEXT("Скорость") };
		return (Stat >= 0 && Stat < ST_Count) ? Names[Stat] : TEXT("?");
	}

	const TArray<FNature>& Natures()
	{
		static const TArray<FNature> N = {
			{TEXT("hardy"), TEXT("Выносливый"), -1, -1},
			{TEXT("lonely"), TEXT("Одинокий"), ST_Atk, ST_Def},
			{TEXT("brave"), TEXT("Смелый"), ST_Atk, ST_Spe},
			{TEXT("adamant"), TEXT("Непреклонный"), ST_Atk, ST_SpA},
			{TEXT("naughty"), TEXT("Непослушный"), ST_Atk, ST_SpD},
			{TEXT("bold"), TEXT("Наглый"), ST_Def, ST_Atk},
			{TEXT("docile"), TEXT("Послушный"), -1, -1},
			{TEXT("relaxed"), TEXT("Расслабленный"), ST_Def, ST_Spe},
			{TEXT("impish"), TEXT("Озорной"), ST_Def, ST_SpA},
			{TEXT("lax"), TEXT("Распущенный"), ST_Def, ST_SpD},
			{TEXT("timid"), TEXT("Робкий"), ST_Spe, ST_Atk},
			{TEXT("hasty"), TEXT("Поспешный"), ST_Spe, ST_Def},
			{TEXT("serious"), TEXT("Серьёзный"), -1, -1},
			{TEXT("jolly"), TEXT("Весёлый"), ST_Spe, ST_SpA},
			{TEXT("naive"), TEXT("Наивный"), ST_Spe, ST_SpD},
			{TEXT("modest"), TEXT("Скромный"), ST_SpA, ST_Atk},
			{TEXT("mild"), TEXT("Мягкий"), ST_SpA, ST_Def},
			{TEXT("quiet"), TEXT("Спокойный"), ST_SpA, ST_Spe},
			{TEXT("bashful"), TEXT("Застенчивый"), -1, -1},
			{TEXT("rash"), TEXT("Нахальный"), ST_SpA, ST_SpD},
			{TEXT("calm"), TEXT("Мирный"), ST_SpD, ST_Atk},
			{TEXT("gentle"), TEXT("Нежный"), ST_SpD, ST_Def},
			{TEXT("sassy"), TEXT("Дерзкий"), ST_SpD, ST_Spe},
			{TEXT("careful"), TEXT("Осторожный"), ST_SpD, ST_SpA},
			{TEXT("quirky"), TEXT("Причудливый"), -1, -1},
		};
		return N;
	}

	const FNature* FindNature(const FString& Id)
	{
		for (const FNature& N : Natures())
		{
			if (Id == N.Id) return &N;
		}
		return nullptr;
	}

	float NatureMultiplier(const FString& NatureId, int32 Stat)
	{
		const FNature* N = FindNature(NatureId);
		if (!N) return 1.f;
		if (N->Up == Stat) return 1.1f;
		if (N->Down == Stat) return 0.9f;
		return 1.f;
	}
}
