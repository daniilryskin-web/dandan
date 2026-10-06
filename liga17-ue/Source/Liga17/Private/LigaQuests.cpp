#include "LigaQuests.h"

#include "LigaData.h"

namespace
{
	TArray<FLigaQuestDef> Build()
	{
		TArray<FLigaQuestDef> L;
		auto Item = [](const TCHAR* Id, int32 N) { return TPair<FString, int32>(FString(Id), N); };
		auto Add = [&L](const TCHAR* Id, const TCHAR* Title, const TCHAR* Goal) -> FLigaQuestDef&
		{
			FLigaQuestDef& Q = L.AddDefaulted_GetRef();
			Q.Id = Id;
			Q.Title = Title;
			Q.Goal = Goal;
			return Q;
		};
		{
			FLigaQuestDef& Q = Add(TEXT("starter"), TEXT("Первый партнёр"), TEXT("Получи первого покемона у профессора Оука. Его лаборатория — к югу от площади."));
			Q.bNeedsStarter = false;
			Q.Kind = ELigaQuestGoal::Flag;
			Q.Counter = TEXT("got_starter");
			Q.RewardMoney = 500;
		}
		{
			FLigaQuestDef& Q = Add(TEXT("heal"), TEXT("Покецентр"), TEXT("Вылечи покемонов у медсестры Джой в Покецентре (запад города, красная крыша)."));
			Q.Giver = TEXT("mom");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("heal_center");
			Q.RewardItems = {Item(TEXT("potion"), 2)};
			Q.Offer = {
				TEXT("Если твои покемоны устанут — сходи в Покецентр."),
				TEXT("Он на западе города, с красной крышей. Медсестра Джой вылечит их бесплатно!"),
			};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("parcel"), TEXT("Посылка для профессора"), TEXT("Отнеси посылку профессору Оуку в лабораторию."));
			Q.Giver = TEXT("clerk");
			Q.TurnIn = TEXT("oak");
			Q.Requires = TEXT("starter");
			Q.Kind = ELigaQuestGoal::Talk;
			Q.KeyItem = TEXT("oaks-parcel");
			Q.RewardItems = {Item(TEXT("poke-ball"), 5)};
			Q.Offer = {
				TEXT("О, вы ведь из лаборатории? Профессор Оук заказывал у нас посылку."),
				TEXT("Не могли бы вы отнести её ему? Вот, держите!"),
			};
			Q.Remind = {TEXT("Посылка для профессора Оука у вас. Его лаборатория — к югу от площади.")};
			Q.Done = {
				TEXT("О, это же моя посылка! Спасибо, что принёс."),
				TEXT("Вот, возьми пять покеболов — пригодятся для ловли."),
			};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("shopping"), TEXT("Запасы тренера"), TEXT("Купи в магазине 3 покебола."));
			Q.Giver = TEXT("clerk");
			Q.Requires = TEXT("parcel");
			Q.Counter = TEXT("buy:poke-ball");
			Q.Target = 3;
			Q.RewardItems = {Item(TEXT("great-ball"), 2)};
			Q.Offer = {
				TEXT("Опытный тренер всегда носит с собой запас покеболов."),
				TEXT("Купите у нас 3 покебола — и получите подарок от магазина!"),
			};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("first_catch"), TEXT("Первая поимка"), TEXT("Поймай дикого покемона и покажись профессору Оуку."));
			Q.Giver = TEXT("oak");
			Q.TurnIn = TEXT("oak");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("caught");
			Q.RewardMoney = 300;
			Q.RewardItems = {Item(TEXT("poke-ball"), 3)};
			Q.Offer = {
				TEXT("Теперь попробуй поймать дикого покемона!"),
				TEXT("Сначала ослабь его в бою, потом брось покебол. Возвращайся, когда получится."),
			};
			Q.Remind = {TEXT("Ещё никого не поймал? Ослабь покемона — тогда покебол сработает лучше.")};
			Q.Done = {TEXT("Ты поймал покемона! Великолепно!"), TEXT("Держи ещё немного покеболов.")};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("dex10"), TEXT("Страницы покедекса"), TEXT("Встреть 10 разных видов покемонов и расскажи профессору Оуку."));
			Q.Giver = TEXT("oak");
			Q.TurnIn = TEXT("oak");
			Q.Requires = TEXT("first_catch");
			Q.Kind = ELigaQuestGoal::DexSeen;
			Q.Target = 10;
			Q.RewardMoney = 1000;
			Q.RewardItems = {Item(TEXT("ultra-ball"), 1)};
			Q.Offer = {
				TEXT("Покедекс записывает каждого встреченного покемона."),
				TEXT("Встреть 10 разных видов — в траве, у леса и у моря — и расскажи мне!"),
			};
			Q.Remind = {TEXT("Видов в покедексе: {progress}. Загляни на берег и на опушку леса!")};
			Q.Done = {TEXT("Десять видов! Ты настоящий исследователь."), TEXT("Это ультрабол — самый надёжный покебол. Используй его с умом!")};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("bugs"), TEXT("Коллекционер жуков"), TEXT("Поймай покемона-жука (трава на опушке леса) и покажи Миле."));
			Q.Giver = TEXT("bugkid");
			Q.TurnIn = TEXT("bugkid");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("catch_type:bug");
			Q.RewardMoney = 400;
			Q.RewardItems = {Item(TEXT("antidote"), 3)};
			Q.Offer = {
				TEXT("Я изучаю покемонов-жуков! Они живут в высокой траве у леса."),
				TEXT("Поймай любого жука и покажи мне, пожалуйста!"),
			};
			Q.Remind = {TEXT("Жуки прячутся в траве у леса: Катерпи, Видл, Парас...")};
			Q.Done = {TEXT("Ух ты, настоящий жук! Спасибо, что показал!"), TEXT("Вот противоядия — жуки иногда ядовитые.")};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("sea"), TEXT("Морские обитатели"), TEXT("Поймай водного покемона у моря и покажи Рине на пристани."));
			Q.Giver = TEXT("sailor");
			Q.TurnIn = TEXT("sailor");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("catch_type:water");
			Q.RewardMoney = 600;
			Q.RewardItems = {Item(TEXT("super-potion"), 2)};
			Q.Offer = {
				TEXT("Видишь волны? У берега живут водные покемоны."),
				TEXT("Пройдись по мокрому песку или по пристани — они сами выпрыгнут навстречу. Поймай одного!"),
			};
			Q.Remind = {TEXT("Водные покемоны появляются у самой кромки воды и на пристани.")};
			Q.Done = {TEXT("Отличный улов! Ты прирождённый моряк."), TEXT("Держи суперзелья — в море без них никуда.")};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("training"), TEXT("Тренировка"), TEXT("Победи 10 диких покемонов и возвращайся к Ане."));
			Q.Giver = TEXT("jogger");
			Q.TurnIn = TEXT("jogger");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("defeated");
			Q.Target = 10;
			Q.RewardMoney = 800;
			Q.RewardItems = {Item(TEXT("ether"), 1)};
			Q.Offer = {
				TEXT("Хочешь стать сильнее? Тренируйся каждый день!"),
				TEXT("Победи 10 диких покемонов и приходи ко мне."),
			};
			Q.Remind = {TEXT("Побед: {progress}. Не сдавайся!")};
			Q.Done = {TEXT("10 побед! Вот это я понимаю — тренировка!"), TEXT("Держи эфир: он восстанавливает PP атак.")};
		}
		{
			FLigaQuestDef& Q = Add(TEXT("lost_eevee"), TEXT("Пропавшая Иви"), TEXT("Найди Иви Лизы — она убежала к морю, на восток."));
			Q.Giver = TEXT("girl");
			Q.TurnIn = TEXT("girl");
			Q.Requires = TEXT("starter");
			Q.Counter = TEXT("found:eevee");
			Q.RewardMoney = 700;
			Q.RewardItems = {Item(TEXT("revive"), 1)};
			Q.Offer = {TEXT("Ой, беда! Моя Иви убежала!"), TEXT("Кажется, она побежала к морю, на восток. Пожалуйста, найди её!")};
			Q.Remind = {TEXT("Иви любит гулять по пляжу на востоке. Найди её, пожалуйста!")};
			Q.Done = {TEXT("Иви вернулась! Спасибо тебе огромное!"), TEXT("Возьми оживитель — он поднимает на ноги покемона, потерявшего сознание.")};
		}
		return L;
	}

	FString ItemName(const FString& Id)
	{
		const FLigaItem* It = FLigaDatabase::Get().Item(Id);
		return It ? It->Name : Id;
	}
}

const TArray<FLigaQuestDef>& LigaQuests::All()
{
	static const TArray<FLigaQuestDef> List = Build();
	return List;
}

const FLigaQuestDef* LigaQuests::Find(const FString& Id)
{
	return All().FindByPredicate([&Id](const FLigaQuestDef& Q) { return Q.Id == Id; });
}

int32 LigaQuests::State(const FLigaGameData& D, const FString& Id)
{
	const int32* S = D.QuestStage.Find(Id);
	return S ? *S : 0;
}

int32 LigaQuests::GetCounter(const FLigaGameData& D, const FString& Name)
{
	if (Name == TEXT("caught")) return D.Caught;
	if (Name == TEXT("defeated")) return D.WildDefeated;
	const int32* N = D.Counters.Find(Name);
	return N ? *N : 0;
}

void LigaQuests::AddCounter(FLigaGameData& D, const FString& Name, int32 N)
{
	D.Counters.FindOrAdd(Name) += N;
}

FString LigaQuests::TypeId(EPokeType T)
{
	static const TCHAR* Ids[] = {
		TEXT("normal"), TEXT("fire"), TEXT("water"), TEXT("electric"), TEXT("grass"), TEXT("ice"), TEXT("fighting"), TEXT("poison"), TEXT("ground"),
		TEXT("flying"), TEXT("psychic"), TEXT("bug"), TEXT("rock"), TEXT("ghost"), TEXT("dragon"), TEXT("dark"), TEXT("steel"), TEXT("fairy"),
	};
	const int32 I = (int32)T;
	return I >= 0 && I < (int32)UE_ARRAY_COUNT(Ids) ? FString(Ids[I]) : FString();
}

int32 LigaQuests::Progress(const FLigaGameData& D, const FLigaQuestDef& Q)
{
	switch (Q.Kind)
	{
	case ELigaQuestGoal::Flag:
		return D.HasFlag(Q.Counter) ? Q.Target : 0;
	case ELigaQuestGoal::DexSeen:
		return FMath::Min(Q.Target, D.Dex.Num());
	case ELigaQuestGoal::Talk:
		return 0;
	default:
	{
		const int32* Base = D.QuestBase.Find(Q.Id);
		return FMath::Clamp(GetCounter(D, Q.Counter) - (Base ? *Base : 0), 0, Q.Target);
	}
	}
}

bool LigaQuests::IsComplete(const FLigaGameData& D, const FLigaQuestDef& Q)
{
	return Q.Kind != ELigaQuestGoal::Talk && Progress(D, Q) >= Q.Target;
}

bool LigaQuests::IsAvailable(const FLigaGameData& D, const FLigaQuestDef& Q)
{
	if (State(D, Q.Id) != 0) return false;
	if (Q.bNeedsStarter && D.Team.Num() == 0) return false;
	return Q.Requires.IsEmpty() || State(D, Q.Requires) == 2;
}

void LigaQuests::Start(FLigaGameData& D, const FLigaQuestDef& Q)
{
	D.QuestStage.Add(Q.Id, 1);
	if (Q.Kind == ELigaQuestGoal::Counter) D.QuestBase.Add(Q.Id, GetCounter(D, Q.Counter));
	if (!Q.KeyItem.IsEmpty() && D.ItemCount(Q.KeyItem) == 0) D.AddItem(Q.KeyItem, 1);
}

FString LigaQuests::Finish(FLigaGameData& D, const FLigaQuestDef& Q)
{
	D.QuestStage.Add(Q.Id, 2);
	if (!Q.KeyItem.IsEmpty()) D.Bag.Remove(Q.KeyItem);
	TArray<FString> Parts;
	if (Q.RewardMoney > 0)
	{
		D.Money += Q.RewardMoney;
		Parts.Add(FString::Printf(TEXT("%d монет"), Q.RewardMoney));
	}
	for (const TPair<FString, int32>& It : Q.RewardItems)
	{
		D.AddItem(It.Key, It.Value);
		Parts.Add(FString::Printf(TEXT("%s ×%d"), *ItemName(It.Key), It.Value));
	}
	return Parts.Num() ? TEXT("Награда: ") + FString::Join(Parts, TEXT(", ")) : FString();
}

FString LigaQuests::ProgressText(const FLigaGameData& D, const FLigaQuestDef& Q)
{
	if (Q.Kind == ELigaQuestGoal::Talk || Q.Kind == ELigaQuestGoal::Flag || Q.Target <= 1) return FString();
	return FString::Printf(TEXT("%d из %d"), Progress(D, Q), Q.Target);
}

TArray<FString> LigaQuests::WithProgress(const FLigaGameData& D, const FLigaQuestDef& Q, const TArray<FString>& Lines)
{
	TArray<FString> Out;
	const FString P = ProgressText(D, Q);
	for (const FString& L : Lines) Out.Add(L.Replace(TEXT("{progress}"), *P));
	return Out;
}

FString LigaQuests::MarkerFor(const FLigaGameData& D, const FString& NpcId)
{
	if (NpcId == TEXT("oak") && D.Team.Num() == 0) return TEXT("!");  // the first Pokémon
	bool bActive = false;
	for (const FLigaQuestDef& Q : All())
	{
		const int32 S = State(D, Q.Id);
		if (S == 1 && Q.TurnIn == NpcId && (Q.Kind == ELigaQuestGoal::Talk || IsComplete(D, Q))) return TEXT("?");
		if (S == 1 && (Q.TurnIn == NpcId || (Q.TurnIn.IsEmpty() && Q.Giver == NpcId))) bActive = true;
	}
	for (const FLigaQuestDef& Q : All())
	{
		if (!Q.Giver.IsEmpty() && Q.Giver == NpcId && IsAvailable(D, Q)) return TEXT("!");
	}
	return bActive ? TEXT("…") : FString();
}

void LigaQuests::Upgrade(FLigaGameData& D)
{
	if (D.Team.Num() > 0 && State(D, TEXT("starter")) == 0) D.QuestStage.Add(TEXT("starter"), 2);
}

int32 LigaQuests::NumDone(const FLigaGameData& D)
{
	int32 N = 0;
	for (const FLigaQuestDef& Q : All()) N += State(D, Q.Id) == 2 ? 1 : 0;
	return N;
}
