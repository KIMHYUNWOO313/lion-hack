from django.core.management.base import BaseCommand

from meetings.legal_references_data import LEGAL_REFERENCES
from meetings.models import LegalReference


class Command(BaseCommand):
    help = "Seed legal reference documents into the database"

    def handle(self, *args, **options):
        created = 0
        updated = 0
        for item in LEGAL_REFERENCES:
            obj, was_created = LegalReference.objects.update_or_create(
                country_code=item["country"],
                title=item["title"],
                defaults={
                    "category": item["category"],
                    "summary": item["summary"],
                    "source_url": item.get("url", ""),
                    "keywords": item.get("keywords", ""),
                },
            )
            if was_created:
                created += 1
            else:
                updated += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Legal references: {created} created, {updated} updated, "
                f"{LegalReference.objects.count()} total"
            )
        )
