import random

from django.db import migrations, models


def assign_join_codes(apps, schema_editor):
    MeetingRoom = apps.get_model("meetings", "MeetingRoom")
    used = set()
    for room in MeetingRoom.objects.all():
        for _ in range(100):
            code = f"{random.randint(0, 999999):06d}"
            if code not in used:
                room.join_code = code
                room.save(update_fields=["join_code"])
                used.add(code)
                break


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingroom",
            name="join_code",
            field=models.CharField(db_index=True, max_length=6, null=True, unique=True),
        ),
        migrations.RunPython(assign_join_codes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="meetingroom",
            name="join_code",
            field=models.CharField(db_index=True, max_length=6, unique=True),
        ),
    ]
