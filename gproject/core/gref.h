#include <iostream>
#include <cstring>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <ctime>

class Gref {
    private:
    int RefCount;
    int type;

    public:
    Gref(int _type): type(_type){};
    void setType(int _type);
    int getType();
};