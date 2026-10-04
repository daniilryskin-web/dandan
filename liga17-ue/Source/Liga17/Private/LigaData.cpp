#include "LigaData.h"

#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogLigaData, Log, All);

FLigaDatabase& FLigaDatabase::Get()
{
	static FLigaDatabase Instance;
	if (!Instance.bLoaded) Instance.Load();
	return Instance;
}

FString FLigaDatabase::DataDir()
{
	return FPaths::ProjectContentDir() / TEXT("Liga/Data");
}

bool FLigaDatabase::Load()
{
	if (bLoaded) return true;
	const bool bOk = LoadSpecies(DataDir() / TEXT("species.json")) && LoadMoves(DataDir() / TEXT("moves.json"));
	BuildItems();
	BuildEncounters();
	bLoaded = bOk;
	UE_LOG(LogLigaData, Log, TEXT("Liga data: %d species, %d moves (%s)"), SpeciesList.Num(), Moves.Num(), bOk ? TEXT("ok") : TEXT("FAILED"));
	return bOk;
}

static bool ReadJsonArray(const FString& Path, TArray<TSharedPtr<FJsonValue>>& Out)
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *Path))
	{
		UE_LOG(LogLigaData, Error, TEXT("Cannot read %s"), *Path);
		return false;
	}
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Out))
	{
		UE_LOG(LogLigaData, Error, TEXT("Bad JSON in %s"), *Path);
		return false;
	}
	return true;
}

bool FLigaDatabase::LoadSpecies(const FString& Path)
{
	TArray<TSharedPtr<FJsonValue>> Arr;
	if (!ReadJsonArray(Path, Arr)) return false;
	SpeciesList.Reset();
	SpeciesList.SetNum(Arr.Num());
	for (const TSharedPtr<FJsonValue>& V : Arr)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O) continue;
		FLigaSpecies S;
		S.Id = O->GetIntegerField(TEXT("id"));
		S.Name = O->GetStringField(TEXT("name"));
		O->TryGetStringField(TEXT("en"), S.En);
		for (const TSharedPtr<FJsonValue>& T : O->GetArrayField(TEXT("types"))) S.Types.Add(LigaTypes::Parse(T->AsString()));
		const TArray<TSharedPtr<FJsonValue>>& Base = O->GetArrayField(TEXT("base"));
		for (int32 i = 0; i < ST_Count && i < Base.Num(); ++i) S.Base[i] = (int32)Base[i]->AsNumber();
		S.CatchRate = O->GetIntegerField(TEXT("catch"));
		S.BaseExp = O->GetIntegerField(TEXT("exp"));
		S.Growth = O->GetStringField(TEXT("growth"));
		double Male = -1.0;
		S.MaleRatio = O->TryGetNumberField(TEXT("male"), Male) ? (float)Male : -1.f;
		S.Stage = O->GetIntegerField(TEXT("stage"));
		double H = 1.0;
		if (O->TryGetNumberField(TEXT("height"), H)) S.Height = (float)H;
		O->TryGetNumberField(TEXT("gen"), S.Gen);
		int32 Flag = 0;
		if (O->TryGetNumberField(TEXT("legendary"), Flag)) S.bLegendary = Flag != 0;
		if (O->TryGetNumberField(TEXT("mythical"), Flag)) S.bMythical = Flag != 0;
		const TArray<TSharedPtr<FJsonValue>>* Evos;
		if (O->TryGetArrayField(TEXT("evolutions"), Evos))
		{
			for (const TSharedPtr<FJsonValue>& E : *Evos)
			{
				const TSharedPtr<FJsonObject> EO = E->AsObject();
				FLigaEvolution Evo;
				Evo.To = EO->GetIntegerField(TEXT("to"));
				EO->TryGetNumberField(TEXT("level"), Evo.Level);
				EO->TryGetStringField(TEXT("item"), Evo.Item);
				EO->TryGetStringField(TEXT("time"), Evo.Time);
				S.Evolutions.Add(Evo);
			}
		}
		for (const TSharedPtr<FJsonValue>& L : O->GetArrayField(TEXT("learnset")))
		{
			const TArray<TSharedPtr<FJsonValue>>& Pair = L->AsArray();
			if (Pair.Num() == 2) S.Learnset.Add(TPair<int32, FString>((int32)Pair[0]->AsNumber(), Pair[1]->AsString()));
		}
		if (S.Id >= 1 && S.Id <= SpeciesList.Num()) SpeciesList[S.Id - 1] = MoveTemp(S);
	}
	return SpeciesList.Num() > 0;
}

bool FLigaDatabase::LoadMoves(const FString& Path)
{
	TArray<TSharedPtr<FJsonValue>> Arr;
	if (!ReadJsonArray(Path, Arr)) return false;
	for (const TSharedPtr<FJsonValue>& V : Arr)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O) continue;
		FLigaMove M;
		M.Id = O->GetStringField(TEXT("id"));
		M.Name = O->GetStringField(TEXT("name"));
		M.Type = LigaTypes::Parse(O->GetStringField(TEXT("type")));
		const FString Cat = O->GetStringField(TEXT("category"));
		M.Category = Cat == TEXT("physical") ? EMoveCategory::Physical : Cat == TEXT("special") ? EMoveCategory::Special : EMoveCategory::Status;
		O->TryGetNumberField(TEXT("power"), M.Power);
		double Acc = 0;
		M.Accuracy = O->TryGetNumberField(TEXT("accuracy"), Acc) ? (int32)Acc : -1;
		O->TryGetNumberField(TEXT("pp"), M.PP);
		O->TryGetNumberField(TEXT("priority"), M.Priority);

		const TSharedPtr<FJsonObject>* FxPtr;
		if (O->TryGetObjectField(TEXT("effect"), FxPtr) && FxPtr->IsValid())
		{
			const TSharedPtr<FJsonObject>& Fx = *FxPtr;
			FLigaMoveEffect& E = M.Effect;
			const TSharedPtr<FJsonObject>* Sub;
			if (Fx->TryGetObjectField(TEXT("status"), Sub))
			{
				E.Status = LigaTypes::ParseStatus((*Sub)->GetStringField(TEXT("id")));
				E.StatusChance = (*Sub)->GetIntegerField(TEXT("chance"));
			}
			if (Fx->TryGetObjectField(TEXT("stats"), Sub))
			{
				E.bHasStats = true;
				E.bStatsSelf = (*Sub)->GetStringField(TEXT("target")) == TEXT("self");
				(*Sub)->TryGetNumberField(TEXT("chance"), E.StatsChance);
				const TSharedPtr<FJsonObject>* Ch;
				if ((*Sub)->TryGetObjectField(TEXT("changes"), Ch))
				{
					for (const auto& KV : (*Ch)->Values)
					{
						const int32 Stat = LigaTypes::ParseBattleStat(KV.Key);
						if (Stat >= 0) E.StatChanges[Stat] = (int32)KV.Value->AsNumber();
					}
				}
			}
			Fx->TryGetNumberField(TEXT("confuse"), E.ConfuseChance);
			Fx->TryGetNumberField(TEXT("flinch"), E.Flinch);
			double D = 0;
			if (Fx->TryGetNumberField(TEXT("drain"), D)) E.Drain = (float)D;
			if (Fx->TryGetNumberField(TEXT("recoil"), D)) E.Recoil = (float)D;
			if (Fx->TryGetNumberField(TEXT("heal"), D)) E.Heal = (float)D;
			const TArray<TSharedPtr<FJsonValue>>* Hits;
			if (Fx->TryGetArrayField(TEXT("multiHit"), Hits) && Hits->Num() == 2)
			{
				E.MultiHitMin = (int32)(*Hits)[0]->AsNumber();
				E.MultiHitMax = (int32)(*Hits)[1]->AsNumber();
			}
			if (const TSharedPtr<FJsonValue> Fixed = Fx->TryGetField(TEXT("fixedDamage")))
			{
				if (Fixed->Type == EJson::String)
				{
					E.FixedDamage = Fixed->AsString() == TEXT("level") ? -2 : -3;
				}
				else
				{
					E.FixedDamage = (int32)Fixed->AsNumber();
				}
			}
			bool B = false;
			if (Fx->TryGetBoolField(TEXT("highCrit"), B)) E.bHighCrit = B;
			if (Fx->TryGetBoolField(TEXT("rest"), B)) E.bRest = B;
			if (Fx->TryGetBoolField(TEXT("flee"), B)) E.bFlee = B;
			if (Fx->TryGetBoolField(TEXT("payDay"), B)) E.bPayDay = B;
			if (Fx->TryGetBoolField(TEXT("hex"), B)) E.bHex = B;
			if (Fx->TryGetBoolField(TEXT("protect"), B)) E.bProtect = B;
			if (Fx->TryGetBoolField(TEXT("recharge"), B)) E.bRecharge = B;
			if (Fx->TryGetBoolField(TEXT("selfKO"), B)) E.bSelfKO = B;
			if (Fx->TryGetBoolField(TEXT("ohko"), B)) E.bOHKO = B;
		}
		Moves.Add(M.Id, MoveTemp(M));
	}
	return Moves.Num() > 0;
}

void FLigaDatabase::BuildItems()
{
	auto Add = [this](const TCHAR* Id, const TCHAR* Name, const TCHAR* Kind, int32 Price, const TCHAR* Desc) -> FLigaItem&
	{
		FLigaItem& It = ItemList.AddDefaulted_GetRef();
		It.Id = Id;
		It.Name = Name;
		It.Kind = Kind;
		It.Price = Price;
		It.Desc = Desc;
		return It;
	};
	ItemList.Reset();
	Add(TEXT("poke-ball"), TEXT("Покебол"), TEXT("ball"), 200, TEXT("Обычный покебол для ловли диких покемонов.")).Ball = 1.f;
	Add(TEXT("great-ball"), TEXT("Супербол"), TEXT("ball"), 600, TEXT("Ловит в 1,5 раза лучше обычного покебола.")).Ball = 1.5f;
	Add(TEXT("ultra-ball"), TEXT("Ультрабол"), TEXT("ball"), 1200, TEXT("Ловит в 2 раза лучше обычного покебола.")).Ball = 2.f;
	Add(TEXT("master-ball"), TEXT("Мастербол"), TEXT("ball"), 0, TEXT("Ловит любого покемона без промаха.")).Ball = 255.f;
	Add(TEXT("potion"), TEXT("Зелье"), TEXT("heal"), 300, TEXT("Восстанавливает 20 HP.")).Heal = 20;
	Add(TEXT("super-potion"), TEXT("Суперзелье"), TEXT("heal"), 700, TEXT("Восстанавливает 60 HP.")).Heal = 60;
	Add(TEXT("hyper-potion"), TEXT("Гиперзелье"), TEXT("heal"), 1200, TEXT("Восстанавливает 120 HP.")).Heal = 120;
	Add(TEXT("max-potion"), TEXT("Максизелье"), TEXT("heal"), 2500, TEXT("Полностью восстанавливает HP.")).Heal = -1;
	Add(TEXT("antidote"), TEXT("Противоядие"), TEXT("status"), 100, TEXT("Излечивает отравление.")).Cure = EStatus::Poison;
	Add(TEXT("paralyze-heal"), TEXT("Антипаралитик"), TEXT("status"), 200, TEXT("Излечивает паралич.")).Cure = EStatus::Paralysis;
	Add(TEXT("awakening"), TEXT("Будильник"), TEXT("status"), 250, TEXT("Будит уснувшего покемона.")).Cure = EStatus::Sleep;
	Add(TEXT("burn-heal"), TEXT("Мазь от ожогов"), TEXT("status"), 250, TEXT("Излечивает ожог.")).Cure = EStatus::Burn;
	Add(TEXT("ice-heal"), TEXT("Размораживатель"), TEXT("status"), 250, TEXT("Размораживает покемона.")).Cure = EStatus::Freeze;
	Add(TEXT("full-heal"), TEXT("Полное лечение"), TEXT("status"), 600, TEXT("Излечивает любой статус.")).bCureAll = true;
	Add(TEXT("revive"), TEXT("Оживитель"), TEXT("revive"), 1500, TEXT("Оживляет покемона с половиной HP.")).Revive = 0.5f;
	Add(TEXT("ether"), TEXT("Эфир"), TEXT("pp"), 1200, TEXT("Восстанавливает 10 PP всем атакам.")).PP = 10;
}

void FLigaDatabase::BuildEncounters()
{
	// Route 1 (Kanto): Pidgey and Rattata as in FireRed/LeafGreen, plus a few rare guests.
	TArray<FLigaEncounter>& R1 = EncounterTables.Add(TEXT("route1"));
	R1.Add({16, 2, 5, 40});  // Пиджи
	R1.Add({19, 2, 4, 36});  // Раттата
	R1.Add({10, 2, 4, 8});   // Катерпи
	R1.Add({13, 2, 4, 8});   // Видл
	R1.Add({21, 3, 5, 5});   // Спироу
	R1.Add({25, 3, 5, 2});   // Пикачу
	R1.Add({133, 4, 5, 1});  // Иви
}

const FLigaSpecies* FLigaDatabase::Species(int32 Id) const
{
	return SpeciesList.IsValidIndex(Id - 1) && SpeciesList[Id - 1].Id == Id ? &SpeciesList[Id - 1] : nullptr;
}

const FLigaMove* FLigaDatabase::Move(const FString& Id) const
{
	return Moves.Find(Id);
}

const FLigaItem* FLigaDatabase::Item(const FString& Id) const
{
	return ItemList.FindByPredicate([&Id](const FLigaItem& It) { return It.Id == Id; });
}
